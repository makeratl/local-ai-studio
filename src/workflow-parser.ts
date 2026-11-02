import * as path from 'path';
import * as fs from 'fs/promises';
import { pathExists } from 'fs-extra/esm';
import { WorkflowMetadata, ComfyUIWorkflow, LoraInfo } from './types.js';

export class WorkflowParser {
  private workflowsDir: string;
  private metadataDir: string;
  private modelsDir: string;
  private localWorkflowsDir: string;

  constructor(comfyuiPath: string, metadataPath: string) {
    this.workflowsDir = path.join(comfyuiPath, 'user/default/workflows');
    this.modelsDir = path.join(comfyuiPath, 'models');
    this.metadataDir = metadataPath;
    // Local symlinked workflows dir
    this.localWorkflowsDir = metadataPath.replace('/workflow-metadata', '/workflows');
  }

  /**
   * Load workflow metadata from JSON file
   */
  async loadMetadata(workflowId: string): Promise<WorkflowMetadata | null> {
    const metadataPath = path.join(this.metadataDir, `${workflowId}.json`);
    try {
      const content = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Load the workflow JSON file
   * Tries local workflows dir first, then ComfyUI workflows dir
   */
  async loadWorkflow(sourceFile: string): Promise<any | null> {
    // Try local workflows directory first
    const localPath = path.join(this.localWorkflowsDir, sourceFile);
    try {
      const content = await fs.readFile(localPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      // Try ComfyUI workflows directory
      const comfyPath = path.join(this.workflowsDir, sourceFile);
      try {
        const content = await fs.readFile(comfyPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    }
  }

  /**
   * Check if workflow is in API format (has class_type inside nodes)
   */
  isApiFormat(workflow: any): boolean {
    // API format: { "3": { "class_type": "...", "inputs": {...} }, ... }
    // Workflow format: { "nodes": [...], "links": [...], ... }
    if (workflow.nodes && Array.isArray(workflow.nodes)) {
      return false; // Workflow format
    }
    return Object.keys(workflow).some(k => {
      const val = workflow[k];
      return val && typeof val === 'object' && 'class_type' in val && 'inputs' in val;
    });
  }

  /**
   * Apply parameters to a workflow (handles both API and workflow formats)
   */
  applyParameters(
    workflow: any,
    metadata: WorkflowMetadata,
    params: Record<string, any>,
    seed?: number,
    filenamePrefix?: string
  ): any {
    // Deep clone the workflow
    const modified = JSON.parse(JSON.stringify(workflow));
    
    // Check format
    if (this.isApiFormat(modified)) {
      return this.applyParametersToApiWorkflow(modified, metadata, params, seed, filenamePrefix);
    } else {
      return this.applyParametersToWorkflowFormat(modified, metadata, params, seed, filenamePrefix);
    }
  }

  /**
   * Apply parameters to an API-format workflow
   */
  private applyParametersToApiWorkflow(
    workflow: any,
    metadata: WorkflowMetadata,
    params: Record<string, any>,
    seed?: number,
    filenamePrefix?: string
  ): any {
    // Apply parameters based on metadata
    for (const [paramName, paramConfig] of Object.entries(metadata.parameters)) {
      const config = paramConfig as any;
      
      // Skip GROUP parameters - they have nested params
      if (config.type === 'GROUP') {
        const groupValue = params[paramName];
        if (groupValue && typeof groupValue === 'object') {
          for (const [subName, subConfig] of Object.entries(config.parameters || {})) {
            const subVal = groupValue[subName];
            if (subVal !== undefined) {
              this.applyParamToApiNode(workflow, subConfig as any, subVal);
            }
          }
        }
        continue;
      }
      
      const value = params[paramName] ?? config.default;
      if (config.remove_if_unset && (value === undefined || value === '')) {
        this.removeApiNode(workflow, config.node?.toString());
        continue;
      }
      if (value === undefined) continue;
      
      this.applyParamToApiNode(workflow, config, value);
    }
    
    // Apply hidden parameters (defaults that should always be set)
    if (metadata.hidden_parameters) {
      for (const [paramName, config] of Object.entries(metadata.hidden_parameters)) {
        if ((config as any).default !== undefined) {
          this.applyParamToApiNode(workflow, config as any, (config as any).default);
        }
      }
    }
    
    // Apply seed if specified
    if (seed !== undefined && metadata.seed_node && metadata.seed_param) {
      const node = workflow[metadata.seed_node.toString()];
      if (node && node.inputs) {
        node.inputs[metadata.seed_param] = seed;
      }
    }
    
    // Apply filename prefix
    if (filenamePrefix && metadata.output?.save_node && metadata.output?.save_param) {
      const saveNode = workflow[metadata.output.save_node.toString()];
      if (saveNode && saveNode.inputs) {
        saveNode.inputs[metadata.output.save_param] = filenamePrefix;
      }
    }
    
    return workflow;
  }

  /**
   * Remove an optional input node and every input that links to it
   */
  private removeApiNode(workflow: any, nodeId: string | undefined): void {
    if (!nodeId || !workflow[nodeId]) return;
    delete workflow[nodeId];
    for (const node of Object.values(workflow) as any[]) {
      for (const [name, val] of Object.entries(node.inputs || {})) {
        if (Array.isArray(val) && val[0]?.toString() === nodeId) delete node.inputs[name];
      }
    }
  }

  /**
   * Apply a single parameter to an API-format node
   */
  private applyParamToApiNode(workflow: any, config: any, value: any): void {
    // Support both old-style (node/input) and new-style (node_path) config
    if (config.node_path && Array.isArray(config.node_path)) {
      // node_path format: [nodeId, "inputs", "paramName"]
      const [nodeId, ...path] = config.node_path;
      const node = workflow[nodeId.toString()];
      if (node && node.inputs && path[0] === 'inputs') {
        node.inputs[path[1]] = value;
      }
    } else if (config.node && config.input) {
      // Legacy format
      const node = workflow[config.node.toString()];
      if (node && node.inputs) {
        node.inputs[config.input] = value;
      }
    }
  }

  /**
   * Apply parameters to a workflow-format workflow (with nodes array)
   */
  private applyParametersToWorkflowFormat(
    workflow: ComfyUIWorkflow,
    metadata: WorkflowMetadata,
    params: Record<string, any>,
    seed?: number,
    filenamePrefix?: string
  ): ComfyUIWorkflow {
    // Build node lookup map
    const nodesMap = new Map<number, any>();
    for (const node of (workflow.nodes || [])) {
      nodesMap.set(node.id, node);
    }

    // Apply user parameters
    for (const [paramName, paramConfig] of Object.entries(metadata.parameters)) {
      if (paramConfig.type === 'GROUP') {
        // Handle grouped parameters
        const groupValue = params[paramName];
        if (groupValue && typeof groupValue === 'object') {
          for (const [subName, subConfig] of Object.entries(paramConfig.parameters)) {
            if (groupValue[subName] !== undefined) {
              this.applyParamToWorkflowNode(nodesMap, subConfig as any, groupValue[subName]);
            }
          }
        }
      } else {
        // Apply regular parameter
        const value = params[paramName];
        if (value !== undefined) {
          this.applyParamToWorkflowNode(nodesMap, paramConfig, value);
        }
      }
    }

    // Apply seed
    if (seed !== undefined && metadata.seed_node) {
      const seedNode = nodesMap.get(metadata.seed_node);
      if (seedNode) {
        const seeds = seedNode.widgets_values || [];
        const seedParam = metadata.seed_param || 'seed';
        // Find the seed index in inputs
        const seedInputIndex = (seedNode.inputs || []).findIndex(
          (inp: any) => inp.name === seedParam
        );
        if (seedInputIndex >= 0 && seedInputIndex < seeds.length) {
          seeds[seedInputIndex] = seed;
        } else if (seedInputIndex === -1) {
          // Seed might be direct widget
          seedNode.widgets_values = [seed, ...(seedNode.widgets_values || [])];
        }
      }
    }

    // Apply filename prefix
    if (filenamePrefix && metadata.output.save_node) {
      const saveNode = nodesMap.get(metadata.output.save_node);
      if (saveNode) {
        // Find filename_prefix in inputs
        const prefixInput = (saveNode.inputs || []).find(
          (inp: any) => inp.name === 'filename_prefix'
        );
        if (prefixInput) {
          const idx = (saveNode.inputs || []).indexOf(prefixInput);
          if (saveNode.widgets_values && idx < saveNode.widgets_values.length) {
            saveNode.widgets_values[idx] = filenamePrefix;
          }
        } else if (saveNode.widgets_values && saveNode.widgets_values.length > 0) {
          // First widget is usually filename_prefix for SaveImage
          saveNode.widgets_values[0] = filenamePrefix;
        }
      }
    }

    return workflow;
  }

  /**
   * Apply a single parameter to a workflow node
   */
  private applyParamToWorkflowNode(
    nodesMap: Map<number, any>,
    paramConfig: any,
    value: any
  ): void {
    const [nodeId, ...path] = paramConfig.node_path;
    const node = nodesMap.get(nodeId);
    if (!node) return;

    // Navigate to the input location
    if (path[0] === 'inputs') {
      const paramName = path[1];
      const inputIndex = (node.inputs || []).findIndex(
        (inp: any) => inp.name === paramName
      );
      
      if (inputIndex >= 0) {
        // Find corresponding widget value
        const widgetInputs = (node.inputs || []).filter((inp: any) => 'widget' in inp);
        const widgetIndex = widgetInputs.findIndex((inp: any) => inp.name === paramName);
        
        if (widgetIndex >= 0 && node.widgets_values && widgetIndex < node.widgets_values.length) {
          node.widgets_values[widgetIndex] = value;
        }
      }
    }
  }

  /**
   * Discover available LoRAs from the models directory
   */
  async discoverLoras(category?: 'qwen' | 'xfs' | 'other'): Promise<LoraInfo[]> {
    const loras: LoraInfo[] = [];
    const lorasDir = path.join(this.modelsDir, 'loras');
    
    // Check qwen subdirectory
    if (!category || category === 'qwen') {
      const qwenDir = path.join(lorasDir, 'qwen');
      if (await pathExists(qwenDir)) {
        const files = await fs.readdir(qwenDir);
        for (const file of files) {
          if (file.endsWith('.safetensors')) {
            loras.push({
              name: `qwen/${file}`,
              path: path.join('qwen', file),
              category: 'qwen'
            });
          }
        }
      }
    }

    // Check xfs subdirectory
    if (!category || category === 'xfs') {
      const xfsDir = path.join(lorasDir, 'xfs');
      if (await pathExists(xfsDir)) {
        const files = await fs.readdir(xfsDir);
        for (const file of files) {
          if (file.endsWith('.safetensors')) {
            loras.push({
              name: `xfs/${file}`,
              path: path.join('xfs', file),
              category: 'xfs'
            });
          }
        }
      }
    }

    // Check root directory for other LoRAs
    if (!category || category === 'other') {
      if (await pathExists(lorasDir)) {
        const files = await fs.readdir(lorasDir);
        for (const file of files) {
          if (file.endsWith('.safetensors')) {
            loras.push({
              name: file,
              path: file,
              category: 'other'
            });
          }
        }
      }
    }

    return loras;
  }

  /**
   * List all available workflows
   */
  async listWorkflows(): Promise<Array<{ id: string; source_file: string; enabled: boolean }>> {
    const catalogPath = path.join(this.metadataDir, 'catalog.json');
    try {
      const content = await fs.readFile(catalogPath, 'utf-8');
      const catalog = JSON.parse(content);
      return Object.entries(catalog.workflows).map(([id, config]: [string, any]) => ({
        id,
        source_file: config.source_file || config.file,
        enabled: config.enabled !== false
      }));
    } catch {
      // If no catalog, scan metadata directory
      const files = await fs.readdir(this.metadataDir);
      return files
        .filter(f => f.endsWith('.json') && f !== 'catalog.json')
        .map(f => ({
          id: f.replace('.json', ''),
          source_file: f,
          enabled: true
        }));
    }
  }
}