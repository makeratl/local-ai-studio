Rules for ComfyUI work:
- run_workflow may return status "running". That means NOT finished. Immediately call get_job_result with the prompt_id and wait_seconds 50. Repeat until status is "completed". Never end your turn while a job is running.
- Your final message must give the output file path from the completed job.
- Before run_workflow, call list_workflows and use an id exactly as listed. Never invent an id.
- Call get_workflow_params before run_workflow and use exact parameter values.
- If a workflow fails, fix it or stop and report. Do not switch categories.
