import axios from 'axios';
import FormData from 'form-data';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { ComfyUIWorkflow, QueueStatus, JobResult } from './types.js';

export interface ComfyUIConfig {
  baseUrl: string;
  comfyOutputDir: string;
  inputDir: string;
}

export class WorkflowRunner {
  private baseUrl: string;
  private comfyOutputDir: string;
  private inputDir: string;

  constructor(config: ComfyUIConfig) {
    this.baseUrl = config.baseUrl;
    this.comfyOutputDir = config.comfyOutputDir;
    this.inputDir = config.inputDir;
  }

  /**
   * Submit a workflow to ComfyUI for execution
   * Handles both API format (flat nodes) and workflow format (with group nodes)
   */
  async submitWorkflow(workflow: ComfyUIWorkflow, clientId?: string): Promise<string> {
    const promptId = randomUUID();
    const workflowAny = workflow as any;
    
    // Check if this is already in API format (nodes are keyed by ID string)
    // API format has numeric string keys with class_type inside
    const isApiFormat = Object.keys(workflowAny).some(k => {
      const val = workflowAny[k];
      return val && typeof val === 'object' && 'class_type' in val && 'inputs' in val;
    });
    
    if (isApiFormat) {
      // Already in API format - use directly with parameter substitution
      return this.submitApiWorkflow(workflowAny, clientId, promptId);
    }
    
    // Workflow format - need to expand group nodes
    return this.submitWorkflowFormat(workflow, clientId, promptId);
  }

  /**
   * Submit an API-format workflow directly (no expansion needed)
   */
  private async submitApiWorkflow(workflow: any, clientId: string | undefined, promptId: string): Promise<string> {
    // Clone to avoid modifying original
    const prompt = JSON.parse(JSON.stringify(workflow));
    
    // Remove any non-node properties (like id, revision, etc.)
    const validKeys = new Set(['prompt_id']);
    for (const key of Object.keys(prompt)) {
      if (key !== 'prompt_id' && !/^-?\d+$/.test(key)) {
        // Check if it looks like a node (has class_type)
        if (!prompt[key].class_type) {
          delete prompt[key];
        }
      }
    }

    const promptData = {
      prompt,
      client_id: clientId || promptId
    };

    console.error('[ComfyUI] Submitting API workflow with', Object.keys(prompt).length, 'nodes');
    
    try {
      const response = await axios.post(`${this.baseUrl}/prompt`, promptData, {
        timeout: 120000,
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.data.error) {
        console.error('[ComfyUI] Error:', JSON.stringify(response.data.error, null, 2));
        throw new Error(`ComfyUI error: ${JSON.stringify(response.data.error)}`);
      }

      return response.data.prompt_id;
    } catch (error: any) {
      if (error.response) {
        console.error('[ComfyUI] Response error:', error.response.status, error.response.data);
        throw new Error(`ComfyUI API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Submit a workflow-format workflow (with group nodes that need expansion)
   */
  private async submitWorkflowFormat(workflow: ComfyUIWorkflow, clientId: string | undefined, promptId: string): Promise<string> {
    const workflowAny = workflow as any;
    
    // Build maps
    const linksMap = new Map<number, any[]>();
    if (workflow.links) {
      for (const link of workflow.links) {
        if (link && link.length >= 5) {
          linksMap.set(link[0] as number, link);
        }
      }
    }
    
    // Build subgraph definition map: id -> subgraph definition
    const subgraphMap = new Map<string, any>();
    const definitions = workflowAny.definitions || {};
    const subgraphs = definitions.subgraphs || [];
    for (const sg of subgraphs) {
      if (sg.id) {
        subgraphMap.set(sg.id, sg);
      }
    }
    
    // Build group node template map from extra.groupNodes
    // These define the internal nodes for "workflow>name" type nodes
    const groupNodeMap = new Map<string, any>();
    const groupNodes = workflowAny.extra?.groupNodes || {};
    for (const [name, def] of Object.entries(groupNodes)) {
      groupNodeMap.set(name, def);
    }
    
    // Build the prompt by expanding all group nodes recursively
    const prompt: any = {};
    const nodeWidgetValues = new Map<number, any[]>(); // Store widget values for each node
    
    // First pass: collect all widget values from top-level nodes
    for (const node of (workflow.nodes || [])) {
      if (node.widgets_values) {
        nodeWidgetValues.set(node.id, node.widgets_values);
      }
    }
    
    // Second pass: expand nodes
    for (const node of (workflow.nodes || [])) {
      this.processNode(node, workflowAny, subgraphMap, groupNodeMap, linksMap, prompt, nodeWidgetValues);
    }

    const promptData = {
      prompt,
      client_id: clientId || promptId
    };

    console.error('[ComfyUI] Submitting workflow with', Object.keys(prompt).length, 'nodes');
    
    try {
      const response = await axios.post(`${this.baseUrl}/prompt`, promptData, {
        timeout: 120000,
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.data.error) {
        console.error('[ComfyUI] Error:', JSON.stringify(response.data.error, null, 2));
        throw new Error(`ComfyUI error: ${JSON.stringify(response.data.error)}`);
      }

      return response.data.prompt_id;
    } catch (error: any) {
      if (error.response) {
        console.error('[ComfyUI] Response error:', error.response.status, error.response.data);
        throw new Error(`ComfyUI API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Process a node - expand if it's a group node, or add as regular node
   */
  private processNode(
    node: any,
    workflow: any,
    subgraphMap: Map<string, any>,
    groupNodeMap: Map<string, any>,
    linksMap: Map<number, any[]>,
    prompt: any,
    nodeWidgetValues: Map<number, any[]>,
    inheritedWidgetValues?: Map<string, any>
  ): void {
    const nodeType = node.type;
    const widgetValues = nodeWidgetValues.get(node.id) || node.widgets_values || [];
    
    // Check if this is a "workflow>name" group node
    if (nodeType.startsWith('workflow>')) {
      const groupName = nodeType.substring('workflow>'.length);
      const groupDef = groupNodeMap.get(groupName);
      
      if (groupDef) {
        this.expandGroupNodeTemplate(node, groupDef, linksMap, prompt, widgetValues, subgraphMap, groupNodeMap, workflow);
      } else {
        console.error(`[ComfyUI] Warning: No definition for group node ${nodeType}`);
      }
      return;
    }
    
    // Check if this is a UUID subgraph reference
    if (subgraphMap.has(nodeType)) {
      const subgraph = subgraphMap.get(nodeType);
      this.expandSubgraphNode(node, subgraph, linksMap, prompt, widgetValues, subgraphMap, groupNodeMap, workflow);
      return;
    }
    
    // Regular node - convert to prompt format
    prompt[node.id.toString()] = this.nodeToPrompt(node, linksMap, widgetValues);
  }

  /**
   * Expand a "workflow>name" group node template
   */
  private expandGroupNodeTemplate(
    groupNode: any,
    groupDef: any,
    linksMap: Map<number, any[]>,
    prompt: any,
    widgetValues: any[],
    subgraphMap: Map<string, any>,
    groupNodeMap: Map<string, any>,
    workflow: any
  ): void {
    // Group template defines internal nodes with -1 IDs
    // We need to re-ID them and expand any nested subgraphs
    const templateNodes = groupDef.nodes || [];
    const idMap = new Map<number, number>(); // old ID -> new ID
    
    // Assign new IDs for internal nodes
    let nextId = 1000;
    for (const tmplNode of templateNodes) {
      idMap.set(tmplNode.id, nextId++);
    }
    
    // Map template inputs to widget values from group node
    const inputDefs = groupDef.inputs || [];
    const inputValueMap = new Map<string, any>();
    const groupInputs = groupNode.inputs || [];
    
    // Widget values order matches the inputs order in the group template
    // The groupNode.widgets_values contains values for the template's inputs
    for (let i = 0; i < inputDefs.length && i < widgetValues.length; i++) {
      inputValueMap.set(inputDefs[i].name, widgetValues[i]);
    }
    
    // Process each template node
    for (const tmplNode of templateNodes) {
      const newId = idMap.get(tmplNode.id)!;
      
      // Check if this is a nested subgraph
      if (subgraphMap.has(tmplNode.type)) {
        // Recursively expand
        const nestedSubgraph = subgraphMap.get(tmplNode.type);
        const nestedWidgetValues = this.extractWidgetValuesForNode(tmplNode, inputValueMap);
        this.expandSubgraphNode(tmplNode, nestedSubgraph, linksMap, prompt, nestedWidgetValues, subgraphMap, groupNodeMap, workflow);
      } else {
        // Regular node within template
        const inputs: any = {};
        
        // Get widget values for this node from template
        if (tmplNode.widgets_values) {
          const tmplInputs = tmplNode.inputs || [];
          let wIdx = 0;
          for (const inp of tmplInputs) {
            // Check if this input has an external value
            if (inp.link !== null && inp.link !== undefined) {
              // Linked - will handle below
            } else {
              // Use template's widget value, but override with external if provided
              let value = wIdx < tmplNode.widgets_values.length ? tmplNode.widgets_values[wIdx] : undefined;
              
              // Override from external group inputs if this input name matches
              if (inputValueMap.has(inp.name)) {
                value = inputValueMap.get(inp.name);
              }
              
              if (value !== undefined) {
                inputs[inp.name] = value;
              }
              wIdx++;
            }
          }
        }
        
        prompt[newId.toString()] = {
          class_type: tmplNode.type,
          inputs
        };
      }
    }
  }

  /**
   * Expand a subgraph node (UUID-referenced subgraph from definitions.subgraphs)
   */
  private expandSubgraphNode(
    subgraphNode: any,
    subgraph: any,
    linksMap: Map<number, any[]>,
    prompt: any,
    widgetValues: any[],
    subgraphMap: Map<string, any>,
    groupNodeMap: Map<string, any>,
    workflow: any
  ): void {
    const internalNodes = subgraph.nodes || [];
    const inputDefs = subgraph.inputs || [];
    
    // Map input values from parent node
    const inputValueMap = new Map<string, any>();
    const nodeInputs = subgraphNode.inputs || [];
    
    for (let i = 0; i < inputDefs.length && i < widgetValues.length; i++) {
      inputValueMap.set(inputDefs[i].name, widgetValues[i]);
    }
    
    // Assign new IDs
    const idMap = new Map<number, number>();
    let nextId = 2000;
    
    for (const intNode of internalNodes) {
      if (intNode.id !== -10 && intNode.id !== -20) { // Skip I/O pseudo-nodes
        idMap.set(intNode.id, nextId++);
      }
    }
    
    // Process internal nodes
    for (const intNode of internalNodes) {
      // Skip I/O pseudo-nodes
      if (intNode.id === -10 || intNode.id === -20) continue;
      
      const newId = idMap.get(intNode.id);
      if (!newId) continue;
      
      // Check for nested subgraph
      if (subgraphMap.has(intNode.type)) {
        const nestedSubgraph = subgraphMap.get(intNode.type);
        const nestedWidgetValues = intNode.widgets_values || [];
        this.expandSubgraphNode(intNode, nestedSubgraph, linksMap, prompt, nestedWidgetValues, subgraphMap, groupNodeMap, workflow);
        continue;
      }
      
      // Regular internal node
      const inputs: any = {};
      
      // Get widget values
      if (intNode.widgets_values) {
        const intInputs = intNode.inputs || [];
        let wIdx = 0;
        for (const inp of intInputs) {
          if (inp.link === null || inp.link === undefined) {
            let value = wIdx < intNode.widgets_values.length ? intNode.widgets_values[wIdx] : undefined;
            
            // Override from external inputs
            if (inputValueMap.has(inp.name)) {
              value = inputValueMap.get(inp.name);
            }
            
            if (value !== undefined) {
              inputs[inp.name] = value;
            }
            wIdx++;
          }
        }
      }
      
      // Handle linked inputs - need to map to new IDs
      if (intNode.inputs) {
        for (const inp of intNode.inputs) {
          if (inp.link !== null && inp.link !== undefined) {
            // Find the link
            const link = linksMap.get(inp.link);
            if (link) {
              const sourceId = link[1];
              const sourceSlot = link[2];
              
              // Check if source is -10 (input pseudo-node)
              if (sourceId === -10) {
                // Use external input value
                const extInputName = inputDefs.find((d: any) => d.linkIds?.includes(inp.link))?.name;
                if (extInputName && inputValueMap.has(extInputName)) {
                  inputs[inp.name] = inputValueMap.get(extInputName);
                }
              } else {
                // Map source ID to new ID
                const newSourceId = idMap.get(sourceId) || sourceId;
                inputs[inp.name] = [newSourceId, sourceSlot];
              }
            }
          }
        }
      }
      
      prompt[newId.toString()] = {
        class_type: intNode.type,
        inputs
      };
    }
  }

  /**
   * Extract widget values for a specific node from the input value map
   */
  private extractWidgetValuesForNode(node: any, inputValueMap: Map<string, any>): any[] {
    const values: any[] = [];
    const inputs = node.inputs || [];
    
    for (const inp of inputs) {
      if (inp.link === null || inp.link === undefined) {
        if (inputValueMap.has(inp.name)) {
          values.push(inputValueMap.get(inp.name));
        }
      }
    }
    return values;
  }

  /**
   * Convert a regular node to prompt format
   */
  private nodeToPrompt(node: any, linksMap: Map<number, any[]>, widgetValues?: any[]): any {
    const inputs: any = {};
    
    if (node.inputs) {
      for (const input of node.inputs) {
        const inputName = input.name;
        
        if (input.link !== null && input.link !== undefined) {
          const link = linksMap.get(input.link);
          if (link) {
            inputs[inputName] = [link[1], link[2]];
          }
        }
      }
    }
    
    // Add widget values for unlinked inputs
    const values = widgetValues || node.widgets_values || [];
    if (values.length > 0 && node.inputs) {
      const unlinkedInputs = node.inputs.filter((i: any) => i.link === null || i.link === undefined);
      for (let i = 0; i < unlinkedInputs.length && i < values.length; i++) {
        inputs[unlinkedInputs[i].name] = values[i];
      }
    }
    
    return {
      class_type: node.type,
      inputs
    };
  }

  /**
   * Poll for workflow completion
   */
  async pollForCompletion(
    promptId: string,
    maxAttempts: number = 60,
    intervalMs: number = 2000
  ): Promise<{ images: string[]; generationTimeMs: number }> {
    const startTime = Date.now();
    let attempts = 0;

    while (attempts < maxAttempts) {
      const queueResponse = await axios.get(`${this.baseUrl}/queue`, { timeout: 10000 });
      const queue = queueResponse.data;

      const inRunning = queue.queue_running?.some((item: any) => item[1] === promptId);
      const inPending = queue.queue_pending?.some((item: any) => item[1] === promptId);

      if (!inRunning && !inPending) {
        console.error(`[ComfyUI] Workflow completed after ${attempts + 1} polls`);
        const history = await this.getHistory(promptId);
        const images = await this.extractImages(history, promptId);
        
        return {
          images,
          generationTimeMs: Date.now() - startTime
        };
      }

      if (inRunning) {
        console.error(`[ComfyUI] Attempt ${attempts + 1}: Workflow running...`);
      } else {
        console.error(`[ComfyUI] Attempt ${attempts + 1}: Workflow pending in queue...`);
      }

      await this.sleep(intervalMs);
      attempts++;
    }

    throw new Error(`Workflow timed out after ${maxAttempts} attempts (${Math.floor(maxAttempts * intervalMs / 1000 / 60)} minutes)`);
  }

  async getHistory(promptId: string): Promise<any> {
    const response = await axios.get(`${this.baseUrl}/history/${promptId}`, { timeout: 10000 });
    return response.data;
  }

  /**
   * Resolve a completed job's outputs to absolute paths in ComfyUI's own
   * output directory. ComfyUI has already written these files natively, so
   * the MCP returns the path to that single source of truth — it does not
   * copy anything.
   */
  async extractImages(history: any, promptId: string): Promise<string[]> {
    const images: string[] = [];
    const historyEntry = history[promptId];

    if (!historyEntry || !historyEntry.outputs) {
      return images;
    }

    for (const [nodeId, output] of Object.entries(historyEntry.outputs)) {
      const outputData = output as any;
      if (outputData.images) {
        for (const img of outputData.images) {
          if (img.type && img.type !== 'output') continue;  // skip input/temp previews (e.g. LoadVideo)
          images.push(path.join(this.comfyOutputDir, img.subfolder || '', img.filename));
        }
      }
    }

    return images;
  }

  async uploadImage(imagePath: string, subfolder?: string): Promise<string> {
    const filename = path.basename(imagePath);
    const form = new FormData();
    
    form.append('image', await fs.readFile(imagePath), {
      filename,
      contentType: this.getContentType(filename)
    });
    
    if (subfolder) {
      form.append('subfolder', subfolder);
    }

    const response = await axios.post(`${this.baseUrl}/upload/image`, form, {
      headers: form.getHeaders(),
      timeout: 60000
    });

    return response.data.name || filename;
  }

  async getQueueStatus(): Promise<QueueStatus> {
    const response = await axios.get(`${this.baseUrl}/queue`, { timeout: 10000 });
    return {
      queue_running: response.data.queue_running || [],
      queue_pending: response.data.queue_pending || []
    };
  }

  async cancelJob(promptId: string): Promise<void> {
    await axios.post(`${this.baseUrl}/interrupt`, { prompt_id: promptId }, { timeout: 10000 });
  }

  async getAvailableModels(): Promise<Record<string, string[]>> {
    const response = await axios.get(`${this.baseUrl}/object_info`, { timeout: 30000 });
    const models: Record<string, string[]> = {};
    
    const data = response.data;
    for (const [nodeType, nodeInfo] of Object.entries(data)) {
      if (nodeType.includes('Loader') || nodeType.includes('Load')) {
        const inputs = (nodeInfo as any).input?.required || {};
        for (const [paramName, paramDef] of Object.entries(inputs)) {
          if (Array.isArray(paramDef) && Array.isArray(paramDef[0])) {
            const values = paramDef[0];
            models[paramName] = values;
          }
        }
      }
    }

    return models;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getContentType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4'
    };
    return types[ext || ''] || 'application/octet-stream';
  }
}