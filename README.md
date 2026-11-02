# Local AI Estimator

For knowing what open-weight models your machine can run.

It combines:

- **Artificial Analysis Intelligence Index** scores for open-weight models.
- **Quantization accuracy retention** from published Unsloth / AtomicChat / GGUF / NVIDIA measurements (with conservative estimates where no measurement exists).
- **Real weight layouts** from Hugging Face configs and safetensors dtype totals: dense weights, routed MoE experts, and DeepSeek Engram tables.
- **Real GGUF and safetensors file sizes** from official, Unsloth, ggml-org, bartowski, and NVIDIA repositories.
- **KV-cache** estimates per token, always in FP16/BF16 — never quantized.

## What the controls do

| Control                    | Meaning                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| **Unified memory**         | One shared pool (Apple Silicon, Strix Halo, Grace Blackwell, …).                   |
| **CPU RAM + VRAM**         | A discrete GPU. CPU RAM is only used when MoE CPU offload is enabled.              |
| **SSD**                    | Capacity available for MoE expert streaming and/or Engram tables.                  |
| **Context / Include KV**   | Adds the KV cache at the selected context, capped at each model's maximum context. |
| **MoE experts on SSD**     | Streams the full expert table from SSD; only active experts stay resident.         |
| **MoE experts in CPU RAM** | Keeps inactive experts in system RAM (split architecture).                         |
| **Engram table on SSD**    | Keeps DeepSeek V4.1 Engram lookup tables on SSD.                                   |

Click any bar to pin its full breakdown below the graph. The pinned panel stays open so the Hugging Face link is clickable.

Everything is stored in URL parameters, so a configured view can be bookmarked:

```
?arch=split&ram=128&vram=24&ssd=2000&moeRam=1&engramSsd=1&ctxOn=1&ctx=32768
```

## How sizes are calculated

For each model family, `data/models.js` stores:

- parameter counts for dense, routed-expert, and Engram groups,
- effective bits per group for the base checkpoint and every quant,
- accuracy retention per quant,
- KV-cache bytes per token (full-attention and sliding-window components).

The browser computes:

```
size = Σ (group_params × group_bits / 8) + KV cache
```

The effective bits are calibrated against the published weight files, so a base model reproduces its safetensors total and a quant reproduces its GGUF or safetensors download size.

### Fit logic

- **Dense weights and KV cache** are always resident.
- **MoE experts** are either fully resident, split between active (resident) and inactive (CPU RAM), or streamed from SSD with only the active experts resident.
- **Engram tables** are resident unless Engram SSD offload is on.
- A model is shown only when all of its resident memory, CPU RAM, and SSD requirements fit the entered limits.

## Notes and limitations

- The site includes 29 model families and 238 quantizations (267 bars), including the local llama.cpp models from the home server. Models without a published AAI index carry a clearly marked `~` estimate.
- Measured quant accuracy is top-1 token agreement or benchmark retention where the provider published it (including NVIDIA's NVFP4 evaluation). Entries without a published measurement use a conservative quant-class curve and are marked **estimated** in the tooltip.
- KV-cache sizes are estimates for sizing, not runtime benchmarks. DeepSeek V4.1 reports 890 B/token with FP4 KV; the calculator uses the FP16-equivalent (~3.56 KB/token) because quantized KV is intentionally excluded.
- NVIDIA's DeepSeek V4.1 Flash 1017 NVFP4 checkpoint (429 GB) is included only because its model card reports measured benchmark results; mean retention versus its MXFP4 source is 99.87% across six benchmarks.
- Sizes are decimal GB (1 TB = 1000 GB), matching Hugging Face / GGUF file sizes.
- This is an estimator. Real-world memory use also depends on runtime, batch size, vision tower, MTP heads, allocator overhead, and OS reservations.
