package com.metamorph.almira.kotlin

import com.fasterxml.jackson.databind.JsonNode
import com.metamorph.almira.WebhookVerifier
import java.time.Duration
import java.time.Instant
import java.nio.file.Path

const val CONTRACT_VERSION: String = "0.1.0-dev.59"

data class CollectionReference(
    val tenantId: String,
    val projectId: String,
    val environmentId: String,
    val collectionInstanceId: String,
)

data class FileReference(
    val tenantId: String,
    val projectId: String,
    val environmentId: String,
    val collectionInstanceId: String,
    val entryId: String,
)

data class GenerationReference(
    val tenantId: String,
    val projectId: String,
    val environmentId: String,
    val collectionInstanceId: String,
    val entryId: String,
    val generationId: String,
)

data class DerivativeReference(
    val tenantId: String,
    val projectId: String,
    val environmentId: String,
    val collectionInstanceId: String,
    val entryId: String,
    val generationId: String,
    val variantKey: String,
)

data class ProjectReference(val tenantId: String, val projectId: String)

class AlmiraDataClient(
    baseUrl: String,
    capability: () -> String,
    origin: String? = null,
    retry: RetryPolicy = RetryPolicy(),
) {
    private val delegate = com.metamorph.almira.AlmiraDataClient(
        baseUrl,
        capability,
        origin,
        com.metamorph.almira.AlmiraDataClient.RetryPolicy(retry.maxAttempts, retry.baseDelay, retry.maximumDelay),
    )

    fun listFilesWithCapability(reference: CollectionReference, filters: Map<String, Any?> = emptyMap()): JsonNode =
        delegate.listFilesWithCapability(reference.java(), filters)

    fun searchFilesWithCapability(reference: CollectionReference, request: JsonNode): JsonNode =
        delegate.searchFilesWithCapability(reference.java(), request)

    fun getFileMetadataWithCapability(reference: FileReference): JsonNode =
        delegate.getFileMetadataWithCapability(reference.java())

    fun listDerivativesWithCapability(reference: GenerationReference): JsonNode =
        delegate.listDerivativesWithCapability(reference.java())

    fun readImmutableGeneration(
        reference: GenerationReference,
        range: String? = null,
        ifNoneMatch: String? = null,
    ): com.metamorph.almira.AlmiraDataClient.BinaryResponse =
        delegate.readImmutableGeneration(reference.java(), range, ifNoneMatch)

    fun readDerivative(
        reference: DerivativeReference,
        range: String? = null,
        ifNoneMatch: String? = null,
    ): com.metamorph.almira.AlmiraDataClient.BinaryResponse =
        delegate.readDerivative(reference.java(), range, ifNoneMatch)

    fun readShare(
        shareToken: String,
        range: String? = null,
        ifNoneMatch: String? = null,
    ): com.metamorph.almira.AlmiraDataClient.BinaryResponse =
        delegate.readShare(shareToken, range, ifNoneMatch)
}

data class RetryPolicy(
    val maxAttempts: Int = 1,
    val baseDelay: Duration = Duration.ofMillis(100),
    val maximumDelay: Duration = Duration.ofSeconds(5),
)

class AlmiraServerClient(baseUrl: String, workloadSession: () -> String) {
    private val delegate = com.metamorph.almira.AlmiraServerClient(baseUrl, workloadSession)

    fun createCapabilitySession(reference: CollectionReference, request: JsonNode, operationId: String): JsonNode =
        delegate.createCapabilitySession(reference.java(), request, operationId)

    fun createUpload(reference: CollectionReference, request: JsonNode, operationId: String): JsonNode =
        delegate.createUpload(reference.java(), request, operationId)

    fun createUploadPart(reference: CollectionReference, transferSessionId: String, request: JsonNode, operationId: String): JsonNode =
        delegate.createUploadPart(reference.java(), transferSessionId, request, operationId)

    fun finalizeUpload(reference: CollectionReference, transferSessionId: String, request: JsonNode, operationId: String): JsonNode =
        delegate.finalizeUpload(reference.java(), transferSessionId, request, operationId)

    fun bindSubject(reference: CollectionReference, entryId: String, subject: JsonNode, operationId: String): JsonNode =
        delegate.bindSubject(reference.java(), entryId, subject, operationId)

    fun listSubjectBindings(reference: ProjectReference, request: JsonNode): JsonNode =
        delegate.listSubjectBindings(com.metamorph.almira.AlmiraServerClient.ProjectReference(reference.tenantId, reference.projectId), request)

    fun startSubjectLifecycleOperation(reference: ProjectReference, request: JsonNode, operationId: String): JsonNode =
        delegate.startSubjectLifecycleOperation(com.metamorph.almira.AlmiraServerClient.ProjectReference(reference.tenantId, reference.projectId), request, operationId)

    fun readSubjectLifecycleOperation(reference: ProjectReference, request: JsonNode): JsonNode =
        delegate.readSubjectLifecycleOperation(com.metamorph.almira.AlmiraServerClient.ProjectReference(reference.tenantId, reference.projectId), request)

    fun createSubjectExportDownload(reference: ProjectReference, lifecycleOperationId: String, request: JsonNode, operationId: String): JsonNode =
        delegate.createSubjectExportDownload(com.metamorph.almira.AlmiraServerClient.ProjectReference(reference.tenantId, reference.projectId), lifecycleOperationId, request, operationId)

    fun revokeCapabilitySession(reference: CollectionReference, sessionId: String, operationId: String): String =
        delegate.revokeCapabilitySession(reference.java(), sessionId, operationId)
}

fun verifyWebhookSignature(
    secret: ByteArray,
    body: ByteArray,
    headers: Map<String, String>,
    now: Instant = Instant.now(),
    tolerance: Duration = Duration.ofMinutes(5),
): WebhookVerifier.VerifiedWebhook? = WebhookVerifier.verifyWebhookSignature(secret, body, headers, now, tolerance)

fun uploadDirect(
    descriptor: JsonNode,
    source: Path,
    grantPart: ((JsonNode) -> JsonNode)? = null,
): JsonNode = com.metamorph.almira.DirectTransfer.uploadDirect(
    descriptor,
    source,
    grantPart?.let { callback -> java.util.function.Function { request -> callback(request) } },
)

private fun CollectionReference.java() = com.metamorph.almira.AlmiraDataClient.CollectionReference(
    tenantId, projectId, environmentId, collectionInstanceId,
)

private fun FileReference.java() = com.metamorph.almira.AlmiraDataClient.FileReference(
    tenantId, projectId, environmentId, collectionInstanceId, entryId,
)

private fun GenerationReference.java() = com.metamorph.almira.AlmiraDataClient.GenerationReference(
    tenantId, projectId, environmentId, collectionInstanceId, entryId, generationId,
)

private fun DerivativeReference.java() = com.metamorph.almira.AlmiraDataClient.DerivativeReference(
    tenantId, projectId, environmentId, collectionInstanceId, entryId, generationId, variantKey,
)
