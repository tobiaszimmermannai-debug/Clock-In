# Clipper mit NVIDIA-GPU (CUDA 12.8 + cuDNN 9 – passend für RTX 50 / Blackwell)
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv ffmpeg fonts-dejavu-core fontconfig libglib2.0-0 \
        ca-certificates curl unzip nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# deno: JavaScript-Laufzeit, die yt-dlp für YouTube braucht
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip
# Claude-CLI (optional nutzbar: llm.backend = claude_cli, Login einmalig im Container)
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

WORKDIR /app
COPY requirements.txt .
RUN python3 -m venv /venv && /venv/bin/pip install -r requirements.txt
ENV PATH=/venv/bin:$PATH

COPY . .
ENV CLIPPER_HOST=0.0.0.0 CLIPPER_DATA_DIR=/data HF_HOME=/data/models CLAUDE_CONFIG_DIR=/data/claude
EXPOSE 8000 8001
CMD ["python", "-m", "clipper"]
