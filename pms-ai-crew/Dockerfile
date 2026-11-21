FROM python:3.13-slim

WORKDIR /app

RUN pip install --no-cache-dir pdm -i https://pypi.tuna.tsinghua.edu.cn/simple

COPY pyproject.toml ./
RUN pdm config pypi.url https://pypi.tuna.tsinghua.edu.cn/simple && pdm install --prod

COPY src/ ./src/

ENV PYTHONUNBUFFERED=1

CMD ["pdm", "run", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
