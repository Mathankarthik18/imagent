FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY server/pyproject.toml ./server/
COPY server/imagent_server ./server/imagent_server
RUN pip install --no-cache-dir ./server
COPY --from=ui /ui/dist ./ui/dist
ENV IMAGENT_UI_DIR=/app/ui/dist
EXPOSE 8300
CMD ["uvicorn", "imagent_server.main:app", "--host", "0.0.0.0", "--port", "8300"]
