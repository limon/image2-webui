FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY app/pyproject.toml app/uv.lock ./
RUN uv sync --frozen --no-dev

COPY app/main.py ./main.py
COPY app/static ./static

RUN mkdir -p /app/data/jobs /app/data/files

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
