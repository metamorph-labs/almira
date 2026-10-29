from __future__ import annotations

import os

from almira import AlmiraDataClient, FileReference, RetryPolicy
from django.http import HttpRequest, JsonResponse


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


def file_metadata(request: HttpRequest, entry_id: str) -> JsonResponse:
    if not request.headers.get("X-App-User"):
        return JsonResponse({"code": "ALMIRA_EXAMPLE_FORBIDDEN"}, status=403)
    entry = client.get_file_metadata_with_capability(FileReference(
        required("ALMIRA_TENANT_ID"), required("ALMIRA_PROJECT_ID"),
        required("ALMIRA_ENVIRONMENT_ID"), required("ALMIRA_COLLECTION_ID"), entry_id,
    ))
    return JsonResponse(entry)
