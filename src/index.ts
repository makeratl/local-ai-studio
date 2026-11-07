import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { WorkflowParser } from './workflow-parser.js';

// MCP clients abort a tool call after 60s; never block longer than this, return 'running' instead
const MAX_WAIT_S = Number(process.env.COMFY_MCP_MAX_WAIT ?? 50);

// Hard limit on what this server will expose or run: comma-separated workflow ids and/or
// categories. Unset means images and upscaling only, '*' allows everything, empty allows nothing.
const ALLOW = process.env.COMFY_MCP_ALLOW ?? 'text-to-image,upscale';
const ALLOWLIST = ALLOW.trim() === '*'
  ? null
  : new Set(ALLOW.split(',').map(s => s.trim()).filter(Boolean));

function isAllowed(id: string, category?: string): boolean {
  return !ALLOWLIST || ALLOWLIST.has(id) || (!!category && ALLOWLIST.has(category));
}

function assertAllowed(id: string, category?: string): void {
  if (!isAllowed(id, category)) {
    throw new Error(`Workflow not allowed: ${id} (${category ?? 'no category'}). This server only allows: ${[...ALLOWLIST!].join(', ') || 'nothing'}. Do not try another category; use list_workflows or tell the user.`);
  }
}
import { WorkflowRunner, ComfyUIConfig } from './workflow-runner.js';
import {
  RunWorkflowParams,
  ListWorkflowsResult,
  GetWorkflowParamsResult,
  LoraInfo,
  QueuedJob
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ComfyMCPServer {
  private server: Server;
  private parser: WorkflowParser;
  private runner: WorkflowRunner;
  private comfyuiPath: string;
  private queuedJobs: Map<string, QueuedJob>;

  constructor() {
    // Configuration
    const comfyuiUrl = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
    const comfyuiPath = process.env.COMFYUI_PATH;
    if (!comfyuiPath) {
      throw new Error('COMFYUI_PATH is not set. Point it at your ComfyUI folder.');
    }
    this.comfyuiPath = comfyuiPath;

    // Initialize components
    const metadataPath = path.join(__dirname, '../workflow-metadata');
    this.parser = new WorkflowParser(this.comfyuiPath, metadataPath);

    // ComfyUI writes generated files to its own output directory. The MCP
    // returns paths into that directory as the single source of truth — it
    // never copies files into the project tree.
    const config: ComfyUIConfig = {
      baseUrl: comfyuiUrl,
      comfyOutputDir: path.join(this.comfyuiPath, 'output'),
      inputDir: path.join(this.comfyuiPath, 'input')
    };
    this.runner = new WorkflowRunner(config);

    this.queuedJobs = new Map();

    // Initialize MCP server
    this.server = new Server(
      { name: 'local-ai-studio', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getToolDefinitions()
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      try {
        let result;
        
        switch (name) {
          case 'list_workflows':
            result = await this.handleListWorkflows();
            break;
          case 'get_workflow_params':
            result = await this.handleGetWorkflowParams(args as any);
            break;
          case 'run_workflow':
            result = await this.handleRunWorkflow(args as unknown as RunWorkflowParams);
            break;
          case 'get_queue_status':
            result = await this.handleGetQueueStatus();
            break;
          case 'get_job_result':
            result = await this.handleGetJobResult(args as any);
            break;
          case 'cancel_job':
            result = await this.handleCancelJob(args as any);
            break;
          case 'list_loras':
            result = await this.handleListLoras(args as any);
            break;
          case 'upload_image':
            result = await this.handleUploadImage(args as any);
            break;
          case 'download_job_results':
            result = await this.handleDownloadJobResults(args as any);
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: errorMessage }, null, 2) }],
          isError: true
        };
      }
    });
  }

  private getToolDefinitions(): Tool[] {
    return [
      {
        name: 'list_workflows',
        description: 'List all available ComfyUI workflow templates with their categories and descriptions.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'get_workflow_params',
        description: 'Get the parameter schema for a specific workflow, including required/optional parameters, types, defaults, and available options.',
        inputSchema: {
          type: 'object',
          properties: {
            workflow_id: {
              type: 'string',
              description: 'The workflow ID (e.g., "qwen-lightning-4step", "minimax-h3-i2v-fast")'
            }
          },
          required: ['workflow_id']
        }
      },
      {
        name: 'run_workflow',
        description: 'Execute a ComfyUI workflow with the specified parameters. Returns generated images.',
        inputSchema: {
          type: 'object',
          properties: {
            workflow_id: {
              type: 'string',
              description: 'The workflow ID to execute'
            },
            parameters: {
              type: 'object',
              description: 'Workflow-specific parameters (prompt, lora_name, aspect_ratio, etc.)'
            },
            seed: {
              type: 'integer',
              description: 'Random seed for reproducibility. -1 for random seed.'
            },
            filename_prefix: {
              type: 'string',
              description: 'Strongly recommended: a clear, descriptive name for this generation that becomes the actual ComfyUI output filename (e.g. "raccoon-boardroom-ceo", "product-hero-shot-blue"). Use cohesive, human-readable markers so related images group together and are easy to find later. Reuse the same base name across a series, varying a suffix (e.g. "-v2", "-wide"), to keep a batch coherent. Avoid generic or auto-generated names. If omitted, falls back to a generic "Comfy-<workflow>" prefix, which makes outputs hard to identify.'
            },
            wait_for_completion: {
              type: 'boolean',
              description: `Wait for workflow completion (default: true). Waits at most ${MAX_WAIT_S}s per call; longer jobs (video, cold model loads) return status "running" with a prompt_id to pass to get_job_result. If false, returns immediately.`
            },
            timeout: {
              type: 'integer',
              description: `Seconds to wait before returning status "running" (default and max: ${MAX_WAIT_S}). Only used when wait_for_completion=true.`
            }
          },
          required: ['workflow_id', 'parameters']
        }
      },
      {
        name: 'get_queue_status',
        description: 'Get the current ComfyUI queue status (running and pending jobs).',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'get_job_result',
        description: 'Get the result of a completed or running job by its prompt ID. Pass wait_seconds to block until it finishes (repeat the call while status is "running").',
        inputSchema: {
          type: 'object',
          properties: {
            prompt_id: {
              type: 'string',
              description: 'The prompt/job ID returned from run_workflow'
            },
            wait_seconds: {
              type: 'integer',
              description: `Block up to this many seconds for the job to finish (default 0 = check once, max ${MAX_WAIT_S})`
            }
          },
          required: ['prompt_id']
        }
      },
      {
        name: 'cancel_job',
        description: 'Cancel a queued or running job.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt_id: {
              type: 'string',
              description: 'The prompt/job ID to cancel'
            }
          },
          required: ['prompt_id']
        }
      },
      {
        name: 'list_loras',
        description: 'Discover available LoRA models categorized by type (qwen, xfs, other).',
        inputSchema: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['qwen', 'xfs', 'other'],
              description: 'Filter by LoRA category (optional)'
            }
          }
        }
      },
      {
        name: 'upload_image',
        description: 'Upload a local file (image, audio or video) into ComfyUI\'s input folder. Optional: run_workflow uploads local paths given for image/audio/video parameters itself, including files in ComfyUI\'s output folder. Returns the filename to pass instead.',
        inputSchema: {
          type: 'object',
          properties: {
            image_path: {
              type: 'string',
              description: 'Local file path to the image'
            },
            subfolder: {
              type: 'string',
              description: 'Optional subfolder within ComfyUI input directory'
            }
          },
          required: ['image_path']
        }
      },
      {
        name: 'download_job_results',
        description: 'Resolve the native ComfyUI output file paths for a completed async job. Use after run_workflow with wait_for_completion=false. Returns absolute paths to the files ComfyUI already wrote in its own output directory — it does not copy anything.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt_id: {
              type: 'string',
              description: 'The prompt/job ID returned from run_workflow'
            }
          },
          required: ['prompt_id']
        }
      }
    ];
  }

  // Tool handlers

  private async handleListWorkflows(): Promise<ListWorkflowsResult> {
    const workflows = await this.parser.listWorkflows();
    const results = [];

    for (const w of workflows) {
      if (!w.enabled) continue;
      
      const metadata = await this.parser.loadMetadata(w.id);
      if (metadata && isAllowed(w.id, metadata.category)) {
        results.push({
          id: w.id,
          display_name: metadata.display_name,
          category: metadata.category,
          description: metadata.description
        });
      }
    }

    return { workflows: results };
  }

  private async handleGetWorkflowParams(args: { workflow_id: string }): Promise<GetWorkflowParamsResult> {
    const metadata = await this.parser.loadMetadata(args.workflow_id);
    if (!metadata) {
      throw new Error(`Workflow not found: ${args.workflow_id}`);
    }
    assertAllowed(args.workflow_id, metadata.category);

    const parameters: Record<string, any> = {};
    
    for (const [name, config] of Object.entries(metadata.parameters)) {
      if (config.type === 'GROUP') {
        // Flatten group for API response
        for (const [subName, subConfig] of Object.entries((config as any).parameters)) {
          parameters[`${name}.${subName}`] = {
            type: (subConfig as any).type,
            required: false,
            default: (subConfig as any).default,
            options: (subConfig as any).options,
            description: (subConfig as any).description
          };
        }
      } else {
        parameters[name] = {
          type: (config as any).type,
          required: (config as any).required || false,
          default: (config as any).default,
          options: (config as any).options,
          description: (config as any).description
        };
      }
    }

    return {
      id: metadata.id,
      display_name: metadata.display_name,
      category: metadata.category,
      description: metadata.description,
      parameters
    };
  }

  private async handleRunWorkflow(args: RunWorkflowParams): Promise<any> {
    let { workflow_id, parameters, seed, filename_prefix, wait_for_completion = true, timeout = MAX_WAIT_S } = args;
    const waitS = Math.max(2, Math.min(timeout, MAX_WAIT_S));
    
    let parsedParams: Record<string, any> = {};
    if (typeof parameters === 'string') {
      try {
        parsedParams = JSON.parse(parameters as string);
      } catch {
        try {
          parsedParams = JSON.parse((parameters as string).replace(/'/g, '"'));
        } catch {
          console.error('[ComfyMCP] Failed to parse parameters:', parameters);
        }
      }
    } else if (parameters && typeof parameters === 'object') {
      parsedParams = parameters;
    }

    const metadata = await this.parser.loadMetadata(workflow_id);
    if (!metadata) {
      throw new Error(`Workflow not found: ${workflow_id}`);
    }
    assertAllowed(workflow_id, metadata.category);

    const workflow = await this.parser.loadWorkflow(metadata.source_file);
    if (!workflow) {
      throw new Error(`Failed to load workflow file: ${metadata.source_file}`);
    }

    if (metadata.min_swap_gb) {
      // Linux only; elsewhere the check is skipped
      const meminfo = await fs.readFile('/proc/meminfo', 'utf-8').catch(() => null);
      const swapGb = parseInt(meminfo?.match(/SwapTotal:\s+(\d+)/)?.[1] ?? '0', 10) / 1024 ** 2;
      if (meminfo && swapGb < metadata.min_swap_gb) {
        throw new Error(`${workflow_id} needs >= ${metadata.min_swap_gb} GB swap (have ${swapGb.toFixed(1)} GB); ComfyUI would OOM. Add swap and try again`);
      }
    }

    for (const [paramName, paramConfig] of Object.entries(metadata.parameters)) {
      const config = paramConfig as any;
      if (['IMAGE', 'AUDIO', 'VIDEO'].includes(config.type)
          && typeof parsedParams[paramName] === 'string' && parsedParams[paramName].trim()) {
        parsedParams[paramName] = await this.resolveInputFile(paramName, parsedParams[paramName]);
      }
    }

    // applyParameters edits in place; keep the template to spot loader nodes nothing was bound to
    const template = JSON.parse(JSON.stringify(workflow));

    const actualSeed = seed ?? -1;
    const usedSeed = actualSeed === -1 ? Math.floor(Math.random() * 18446744073709551615) : actualSeed;

    const prefix = filename_prefix || metadata.default_filename_prefix || `Comfy-${workflow_id}`;

    const modifiedWorkflow = this.parser.applyParameters(
      workflow,
      metadata,
      parsedParams,
      usedSeed,
      prefix
    );
    this.assertNoPlaceholderInputs(workflow_id, metadata, parsedParams, template, modifiedWorkflow);

    const promptId = await this.runner.submitWorkflow(modifiedWorkflow);

    const job: QueuedJob = {
      id: promptId,
      workflow_id,
      prompt_id: promptId,
      parameters: { ...parameters, seed: usedSeed },
      status: 'queued',
      start_time: Date.now()
    };
    this.queuedJobs.set(promptId, job);

    console.error(`[ComfyMCP] Workflow submitted: ${workflow_id}, prompt_id: ${promptId}`);

    if (!wait_for_completion) {
      return {
        status: 'queued',
        prompt_id: promptId,
        workflow_id,
        message: 'Job submitted. Use get_job_result to check status.',
        parameters_used: { ...parsedParams, seed: usedSeed }
      };
    }

    try {
      const maxAttempts = Math.floor(waitS / 2);
      const result = await this.runner.pollForCompletion(promptId, maxAttempts, 2000);
      
      if (result.images.length === 0) {
        return await this.checkJobOnce(promptId);  // surfaces ComfyUI execution errors as 'failed'
      }
      job.status = 'completed';
      job.images = result.images;
      job.end_time = Date.now();

      return {
        success: true,
        prompt_id: promptId,
        images: result.images,
        generation_time_ms: result.generationTimeMs,
        parameters_used: { ...parsedParams, seed: usedSeed }
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out')) {
        job.status = 'running';  // ComfyUI keeps rendering; only our wait ended
        return {
          status: 'running',
          prompt_id: promptId,
          workflow_id,
          message: `Still rendering after ${waitS}s (ComfyUI keeps going). Call get_job_result with this prompt_id and wait_seconds: ${MAX_WAIT_S}, repeating while status is "running".`,
          parameters_used: { ...parsedParams, seed: usedSeed }
        };
      }

      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.end_time = Date.now();

      throw error;
    }
  }

  private async handleGetQueueStatus(): Promise<any> {
    const status = await this.runner.getQueueStatus();
    return {
      running_count: status.queue_running.length,
      pending_count: status.queue_pending.length,
      running: status.queue_running.map((item: any) => ({ prompt_id: item[1] })),
      pending: status.queue_pending.map((item: any) => ({ prompt_id: item[1] }))
    };
  }

  private async handleGetJobResult(args: { prompt_id: string; wait_seconds?: number }): Promise<any> {
    const deadline = Date.now() + Math.min(args.wait_seconds ?? 0, MAX_WAIT_S) * 1000;
    let result = await this.checkJobOnce(args.prompt_id);
    while ((result.status === 'queued' || result.status === 'running') && Date.now() + 3000 < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      result = await this.checkJobOnce(args.prompt_id);
    }
    return result;
  }

  private async checkJobOnce(promptId: string): Promise<any> {
    const args = { prompt_id: promptId };
    const job = this.queuedJobs.get(args.prompt_id);
    
    if (job) {
      if (job.status === 'queued' || job.status === 'running') {
        try {
          const history = await this.runner.getHistory(args.prompt_id);
          if (history[args.prompt_id]?.status?.status_str === 'error') {
            const msg = (history[args.prompt_id].status.messages || []).find((m: any) => m[0] === 'execution_error');
            job.status = 'failed';
            job.error = msg ? `${msg[1].node_type}: ${msg[1].exception_message}` : 'ComfyUI execution error';
            job.end_time = Date.now();
          } else if (history[args.prompt_id]) {
            const images = await this.runner.extractImages(history, args.prompt_id);
            job.status = 'completed';
            job.images = images;
            job.end_time = Date.now();
            console.error(`[ComfyMCP] Job ${args.prompt_id} completed asynchronously`);
          } else {
            const queueStatus = await this.runner.getQueueStatus();
            const isRunning = queueStatus.queue_running.some((item: any) => item[1] === args.prompt_id);
            const isPending = queueStatus.queue_pending.some((item: any) => item[1] === args.prompt_id);
            
            if (isRunning) {
              job.status = 'running';
            } else if (!isPending) {
              job.status = 'queued';
            }
          }
        } catch (error) {
          console.error('[ComfyMCP] Error checking job status:', error);
        }
      }
      
      return {
        status: job.status,
        workflow_id: job.workflow_id,
        prompt_id: job.prompt_id,
        parameters: job.parameters,
        images: job.images,
        error: job.error,
        generation_time_ms: job.end_time ? job.end_time - job.start_time : null
      };
    }

    try {
      const history = await this.runner.getHistory(args.prompt_id);
      if (history[args.prompt_id]) {
        const images = await this.runner.extractImages(history, args.prompt_id);
        return {
          status: 'completed',
          prompt_id: args.prompt_id,
          images,
          history: history[args.prompt_id]
        };
      }
    } catch {
      // Ignore
    }

    return {
      status: 'not_found',
      prompt_id: args.prompt_id
    };
  }

  private async handleCancelJob(args: { prompt_id: string }): Promise<any> {
    const job = this.queuedJobs.get(args.prompt_id);
    if (job) {
      job.status = 'cancelled';
    }
    
    await this.runner.cancelJob(args.prompt_id);
    
    return {
      success: true,
      prompt_id: args.prompt_id,
      message: 'Job cancelled'
    };
  }

  private async handleListLoras(args: { category?: 'qwen' | 'xfs' | 'other' }): Promise<{ loras: LoraInfo[] }> {
    const loras = await this.parser.discoverLoras(args.category);
    return { loras };
  }

  /**
   * Turn an IMAGE/AUDIO/VIDEO parameter into a name ComfyUI's loader nodes can read.
   * A local path (absolute, relative, ~ or file://, including ComfyUI's own output folder)
   * is uploaded into the input folder; a bare name already in the input folder, such as
   * an upload_image result, is used as is. Anything else fails loudly.
   */
  private async resolveInputFile(paramName: string, raw: string): Promise<string> {
    const inputDir = path.join(this.comfyuiPath, 'input');
    const isFile = (p: string) => fs.stat(p).then(s => s.isFile(), () => false);
    let value = raw.trim();
    if (value.startsWith('file://')) value = fileURLToPath(value);
    if (value === '~' || value.startsWith('~/')) value = path.join(os.homedir(), value.slice(1));

    const looksLikePath = path.isAbsolute(value) || value.includes('/') || value.includes(path.sep);
    if (!looksLikePath && await isFile(path.join(inputDir, value))) {
      return value;
    }

    const local = path.resolve(value);
    if (await isFile(local)) {
      const inInput = path.relative(inputDir, local);
      if (!inInput.startsWith('..') && !path.isAbsolute(inInput)) {
        return inInput.split(path.sep).join('/');
      }
      const uploaded = await this.runner.uploadImage(local);
      console.error(`[ComfyMCP] Uploaded ${paramName}: ${local} -> ${uploaded}`);
      return uploaded;
    }

    throw new Error(
      `${paramName}: file not found: "${raw}". Pass the absolute path of a local file ` +
      `(it is uploaded to ComfyUI automatically), or a filename returned by upload_image.`
    );
  }

  /**
   * Refuse to queue a prompt in which a loader node still holds the workflow file's own
   * value (example.png and the like). ComfyUI would load that placeholder without
   * complaint and the job would "succeed" on the wrong input.
   */
  private assertNoPlaceholderInputs(workflowId: string, metadata: any, params: Record<string, any>, template: any, prompt: any): void {
    const loaderInputs = ['image', 'audio', 'video', 'file'];
    const paramForNode = new Map<string, string>();
    for (const [name, cfg] of Object.entries(metadata.parameters || {}) as [string, any][]) {
      const nodeId = cfg.node ?? cfg.node_path?.[0];
      if (nodeId !== undefined) paramForNode.set(nodeId.toString(), name);
    }

    const problems: string[] = [];
    for (const [nodeId, node] of Object.entries(prompt) as [string, any][]) {
      if (!/^(VHS_)?Load(Image|Audio|Video)/.test(node?.class_type ?? '')) continue;
      for (const key of loaderInputs) {
        const value = node.inputs?.[key];
        if (typeof value === 'string' && value === template[nodeId]?.inputs?.[key]) {
          const param = paramForNode.get(nodeId);
          if (param && params[param] === value) continue;  // the caller asked for exactly this file
          problems.push(param
            ? `${param} was not provided (node ${nodeId} would load the placeholder "${value}")`
            : `node ${nodeId} (${node.class_type}) has no parameter bound and would load the placeholder "${value}"`);
        }
      }
    }
    if (problems.length) {
      throw new Error(`${workflowId}: refusing to run on placeholder inputs: ${problems.join('; ')}`);
    }
  }

  private async handleUploadImage(args: { image_path: string; subfolder?: string }): Promise<any> {
    const filename = await this.runner.uploadImage(args.image_path, args.subfolder);
    return {
      success: true,
      filename,
      message: `Image uploaded: ${filename}`
    };
  }

  private async handleDownloadJobResults(args: { prompt_id: string }): Promise<any> {
    const history = await this.runner.getHistory(args.prompt_id);

    if (!history[args.prompt_id]) {
      return {
        success: false,
        error: `Job not found in ComfyUI history: ${args.prompt_id}`,
        prompt_id: args.prompt_id
      };
    }

    const historyEntry = history[args.prompt_id];

    if (historyEntry.status?.status_str !== 'success') {
      return {
        success: false,
        error: `Job not completed successfully: ${historyEntry.status?.status_str || 'unknown'}`,
        prompt_id: args.prompt_id,
        status: historyEntry.status
      };
    }

    const images = await this.runner.extractImages(history, args.prompt_id);

    if (images.length === 0) {
      return {
        success: false,
        error: 'No images found in job outputs',
        prompt_id: args.prompt_id
      };
    }

    const job = this.queuedJobs.get(args.prompt_id);
    if (job) {
      job.status = 'completed';
      job.images = images;
      job.end_time = Date.now();
    }

    return {
      success: true,
      prompt_id: args.prompt_id,
      images,
      generation_time_ms: historyEntry.meta?.time_ms || null
    };
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[ComfyMCP] Server started');
  }
}

// Start server
const server = new ComfyMCPServer();
server.run().catch(console.error);