---
title: GaveAI Video Provider
emoji: 🎬
colorFrom: blue
colorTo: purple
sdk: gradio
sdk_version: 6.0.0
app_file: app.py
pinned: false
---

# GaveAI Video Provider

GaveAI external AI video generation provider using:

- Wan2.2 TI2V-5B
- Hugging Face
- Gradio
- ZeroGPU
- Diffusers

## Model

Wan-AI/Wan2.2-TI2V-5B-Diffusers

## API

The Gradio endpoint is:

`/gradio_api/call/generate_video`

The function accepts:

1. prompt
2. num_frames
3. height
4. width
5. guidance_scale

## GaveAI Architecture

GaveAI Backend
→ Hugging Face Space
→ Wan2.2
→ Generated MP4
→ GaveAI Backend
→ ImageKit
→ Public Video URL

## Important

The video provider runs on Hugging Face GPU infrastructure.

The GaveAI backend does not require an NVIDIA GPU.

The local GaveAI development computer can use Intel graphics because video generation happens remotely.

## Output

The provider returns an MP4 file through the Gradio API.