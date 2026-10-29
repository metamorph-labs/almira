from __future__ import annotations

import os

from almira import AlmiraDataClient, FileReference, RetryPolicy
from fastapi import FastAPI, Header, HTTPException


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


client = AlmiraDataClient(
    base_url=required("ALMIRA_BASE_URL"),
    capability=lambda: required("ALMIRA_CAPABILITY"),
    retry=RetryPolicy(max_attempts=3, base_delay_seconds=0.1, maximum_delay_seconds=2),
)
app = FastAPI()


@app.get("/files/{entry_id}")
def file_metadata(entry_id: str, x_app_user: str | None = Header(default=None)) -> object:
    if not x_app_user:
        raise HTTPException(status_code=403, detail={"code": "ALMIRA_EXAMPLE_FORBIDDEN"})
    return client.get_file_metadata_with_capability(FileReference(
        required("ALMIRA_TENANT_ID"), required("ALMIRA_PROJECT_ID"),
        required("ALMIRA_ENVIRONMENT_ID"), required("ALMIRA_COLLECTION_ID"), entry_id,
    ))
