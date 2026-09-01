import os
import uuid
import traceback

import spaces
import torch
import gradio as gr

from diffusers import DiffusionPipeline
from diffusers.utils import export_to_video


# ========================================================
# CONFIGURATION
# ========================================================

MODEL_ID = "Wan-AI/Wan2.2-TI2V-5B-Diffusers"

OUTPUT_DIR = "/tmp/gaveai-videos"

os.makedirs(OUTPUT_DIR, exist_ok=True)


# ========================================================
# GLOBAL PIPELINE
# ========================================================

print("========================================")
print("GAVEAI VIDEO PROVIDER STARTING")
print("MODEL:", MODEL_ID)
print("========================================")

pipe = None


def load_pipeline():

    global pipe

    if pipe is not None:
        return pipe

    print("========================================")
    print("LOADING WAN2.2 TI2V-5B")
    print("========================================")

    pipe = DiffusionPipeline.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.bfloat16,
        device_map="cuda"
    )

    print("Wan2.2 pipeline loaded successfully.")

    return pipe


# ========================================================
# VIDEO GENERATION
# ========================================================

@spaces.GPU(duration=120)
def generate_video(
    prompt: str,
    num_frames: int = 49,
    height: int = 480,
    width: int = 832,
    guidance_scale: float = 5.0
):

    try:

        if not prompt or not prompt.strip():
            raise ValueError("Prompt is required.")

        prompt = prompt.strip()

        print("========================================")
        print("GAVEAI VIDEO GENERATION")
        print("PROMPT:", prompt)
        print("FRAMES:", num_frames)
        print("SIZE:", width, "x", height)
        print("GUIDANCE:", guidance_scale)
        print("========================================")

        pipeline = load_pipeline()

        # ------------------------------------------------
        # FRAME LIMITS
        # ------------------------------------------------

        num_frames = int(num_frames)

        if num_frames < 17:
            num_frames = 17

        if num_frames > 49:
            num_frames = 49

        # ------------------------------------------------
        # SIZE LIMITS
        # ------------------------------------------------

        width = int(width)
        height = int(height)

        width = max(256, min(width, 832))
        height = max(256, min(height, 480))

        width = width - (width % 16)
        height = height - (height % 16)

        # ------------------------------------------------
        # GENERATE
        # ------------------------------------------------

        result = pipeline(
            prompt=prompt,
            num_frames=num_frames,
            height=height,
            width=width,
            guidance_scale=float(guidance_scale)
        )

        frames = result.frames[0]

        # ------------------------------------------------
        # OUTPUT FILE
        # ------------------------------------------------

        video_id = str(uuid.uuid4())

        output_path = os.path.join(
            OUTPUT_DIR,
            f"gaveai-{video_id}.mp4"
        )

        export_to_video(
            frames,
            output_path,
            fps=16
        )

        if not os.path.exists(output_path):
            raise RuntimeError(
                "Video generation completed but MP4 was not created."
            )

        file_size = os.path.getsize(output_path)

        print("========================================")
        print("VIDEO GENERATION SUCCESS")
        print("VIDEO:", output_path)
        print("SIZE:", file_size, "bytes")
        print("========================================")

        return output_path

    except Exception as error:

        print("========================================")
        print("VIDEO GENERATION ERROR")
        print(str(error))
        print("========================================")

        traceback.print_exc()

        raise


# ========================================================
# GRADIO API
# ========================================================

demo = gr.Interface(
    fn=generate_video,

    inputs=[
        gr.Textbox(
            label="Prompt",
            placeholder="Describe the video you want..."
        ),

        gr.Slider(
            minimum=17,
            maximum=49,
            value=49,
            step=4,
            label="Frames"
        ),

        gr.Slider(
            minimum=256,
            maximum=480,
            value=480,
            step=16,
            label="Height"
        ),

        gr.Slider(
            minimum=256,
            maximum=832,
            value=832,
            step=16,
            label="Width"
        ),

        gr.Slider(
            minimum=1,
            maximum=10,
            value=5,
            step=0.5,
            label="Guidance Scale"
        )
    ],

    outputs=gr.Video(
        label="Generated Video"
    ),

    title="GaveAI Video Provider",

    description=(
        "GaveAI self-hosted video generation "
        "using Wan2.2 TI2V-5B on Hugging Face ZeroGPU."
    ),

    api_name="generate_video"
)


# ========================================================
# START
# ========================================================

if __name__ == "__main__":

    print("========================================")
    print("GAVEAI VIDEO PROVIDER READY")
    print("========================================")

    demo.launch()