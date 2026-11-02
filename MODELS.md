# Models

Files each workflow family expects under ComfyUI's `models/` folder. Subfolders in a name are part of the path.

| Folder | File | Used by |
|---|---|---|
| `checkpoints` | `hunyuan3d-dit-v2_fp16.safetensors` | hunyuan3d |
| `controlnet` | `Qwen-Image-2512-Fun-Controlnet-Union-2602.safetensors` | qwen |
| `controlnet` | `Qwen-Image-InstantX-ControlNet-Inpainting.safetensors` | qwen |
| `diffusion_models` | `flux3-image-klein-bf16.safetensors` | flux3 |
| `diffusion_models` | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | minimax |
| `diffusion_models` | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | minimax |
| `diffusion_models` | `qwen_image_2512_fp8_e4m3fn.safetensors` | qwen |
| `diffusion_models` | `qwen_image_edit_2511_fp8mixed.safetensors` | qwen |
| `diffusion_models` | `qwen_image_fp8_e4m3fn.safetensors` | qwen |
| `diffusion_models` | `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | wan |
| `diffusion_models` | `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | wan |
| `loras` | `Qwen-Edit-2509-Multiple-angles.safetensors` | qwen |
| `loras` | `Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors` | qwen |
| `loras` | `Qwen-Image-2512-Lightning-8steps-V1.0-bf16.safetensors` | qwen |
| `loras` | `Qwen-Image-Lightning-4steps-V1.0.safetensors` | qwen |
| `loras` | `minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` | minimax |
| `loras` | `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | minimax |
| `loras` | `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | minimax |
| `loras` | `qwen/Qwen-Image-Lightning-4steps-V1.0.safetensors` | qwen |
| `loras` | `qwen/Qwen-Image-Lightning-8steps-V1.0.safetensors` | qwen |
| `loras` | `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | wan |
| `loras` | `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | wan |
| `text_encoders` | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | minimax |
| `text_encoders` | `qwen3vl_4b_bf16.safetensors` | flux3 |
| `text_encoders` | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | qwen |
| `text_encoders` | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | wan |
| `upscale_models` | `RealESRGAN_x4plus.safetensors` | image, wan |
| `vae` | `Flux/flux2-vae.safetensors` | flux3 |
| `vae` | `minimax_h3_audio_vae_fp32.safetensors` | minimax |
| `vae` | `minimax_h3_video_vae_fp16.safetensors` | minimax |
| `vae` | `qwen_image_vae.safetensors` | qwen |
| `vae` | `wan_2.1_vae.safetensors` | wan |
