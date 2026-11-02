// ComfyUI API types
export interface ComfyUINodeInput {
  name: string;
  type?: string;
  link: number | null;
  widget?: { name: string };
}

export interface ComfyUINodeOutput {
  name: string;
  type: string;
  links: number[] | null;
}

export interface ComfyUINode {
  id: number;
  type: string;
  inputs?: ComfyUINodeInput[];
  outputs?: ComfyUINodeOutput[];
  widgets_values?: any[];
  pos?: [number, number];
  size?: [number, number];
  properties?: Record<string, any>;
}

export interface ComfyUILink {
  id: number;
  source: [number, number]; // [nodeId, slot]
  target: [number, number]; // [nodeId, slot]
  type: string;
}

export interface ComfyUIWorkflow {
  id?: string;
  nodes: ComfyUINode[];
  links?: Array<[number, number, number, number, number, string]>;  // [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, type]
  extra?: Record<string, any>;
  definitions?: Record<string, any>;
}

// Workflow metadata types
export interface WorkflowParameter {
  node_path: string[];
  type: 'STRING' | 'INT' | 'FLOAT' | 'BOOLEAN' | 'COMBO';
  required?: boolean;
  default?: any;
  options?: string[];
  min?: number;
  max?: number;
  description?: string;
  dynamic_options?: boolean;
  discovery_path?: string;
  randomizable?: boolean;
  remove_if_unset?: boolean;  // drop the node (and links into it) when no value is given
}

export interface WorkflowGroupParameter {
  type: 'GROUP';
  description?: string;
  parameters: Record<string, WorkflowParameterSchema>;
}

export type WorkflowParameterSchema = WorkflowParameter | WorkflowGroupParameter;

export interface WorkflowMetadata {
  id: string;
  display_name: string;
  category: 'text-to-image' | 'image-to-image' | 'video' | 'upscale' | '3d';
  source_file: string;
  description: string;
  parameters: Record<string, WorkflowParameterSchema>;
  hidden_parameters?: Record<string, any>;
  seed_node?: number;
  seed_param?: string;
  output: {
    type: 'IMAGE' | 'VIDEO' | 'MODEL_3D';
    save_node: number;
    save_param?: string;
  };
  default_filename_prefix?: string;
  min_swap_gb?: number;  // refuse to run unless this much swap is configured (MiniMax H3 needs about 18 GB)
}

// MCP Tool types
export interface ListWorkflowsResult {
  workflows: Array<{
    id: string;
    display_name: string;
    category: string;
    description: string;
  }>;
}

export interface GetWorkflowParamsResult {
  id: string;
  display_name: string;
  category: string;
  description: string;
  parameters: Record<string, {
    type: string;
    required: boolean;
    default?: any;
    options?: string[];
    description?: string;
  }>;
}

export interface RunWorkflowParams {
  workflow_id: string;
  parameters: Record<string, any>;
  seed?: number;
  batch_size?: number;
  filename_prefix?: string;
  output_directory?: string;
  wait_for_completion?: boolean;
  timeout?: number;
}

export interface RunWorkflowResult {
  success: boolean;
  prompt_id: string;
  images?: string[];
  error?: string;
  generation_time_ms?: number;
  parameters_used: Record<string, any>;
}

export interface QueueStatus {
  queue_running: Array<[string, string]>;
  queue_pending: Array<[string, string]>;
}

export interface JobResult {
  status: 'running' | 'pending' | 'completed' | 'failed';
  images?: string[];
  error?: string;
  generation_time_ms?: number;
}

export interface LoraInfo {
  name: string;
  path: string;
  category: 'qwen' | 'xfs' | 'other';
}

// Queued job tracking
export interface QueuedJob {
  id: string;
  workflow_id: string;
  prompt_id: string;
  parameters: Record<string, any>;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  start_time: number;
  end_time?: number;
  images?: string[];
  error?: string;
}