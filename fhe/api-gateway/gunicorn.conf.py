import os

bind = "0.0.0.0:8000"
workers = int(os.getenv("GUNICORN_WORKERS", "2"))
worker_class = "uvicorn.workers.UvicornWorker"
timeout = 60
keepalive = 5

def post_fork(server, worker):
    # Set the reconciler environment variable to 0 on Gunicorn fork
    # to guarantee that individual FastAPI app lifespans inside web worker threads
    # do NOT spawn duplicate background reconciliation threads.
    os.environ["RUN_RECONCILER_IN_WORKER"] = "0"
    os.environ["RUN_WEBHOOKS_IN_WORKER"] = "0"
    os.environ["RUN_OPERATION_MONITOR_IN_WORKER"] = "0"
    server.log.info(
        "[gunicorn post_fork] worker pid=%s: disabled inline background loops. Run worker_main.py separately.",
        worker.pid
    )
