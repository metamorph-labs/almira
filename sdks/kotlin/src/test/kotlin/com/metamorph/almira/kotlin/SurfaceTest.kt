package com.metamorph.almira.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.assertFailsWith

class SurfaceTest {
    @Test
    fun `application surfaces remain complete`() {
        val data = AlmiraDataClient::class.java.declaredMethods.map { it.name }.toSet()
        assertEquals(
            setOf(
                "getFileMetadataWithCapability",
                "listDerivativesWithCapability",
                "listFilesWithCapability",
                "readDerivative",
                "readImmutableGeneration",
                "readShare",
                "searchFilesWithCapability",
            ),
            data.filterNot { '$' in it }.filterNot { it.startsWith("delegate") }.toSet(),
        )
        val server = AlmiraServerClient::class.java.declaredMethods.map { it.name }.toSet()
        assertEquals(
            setOf(
                "bindSubject",
                "createCapabilitySession",
                "createSubjectExportDownload",
                "createUpload",
                "createUploadPart",
                "finalizeUpload",
                "listSubjectBindings",
                "readSubjectLifecycleOperation",
                "revokeCapabilitySession",
                "startSubjectLifecycleOperation",
            ),
            server.filterNot { it.startsWith("delegate") }.toSet(),
        )
        assertEquals("0.1.0-dev.59", CONTRACT_VERSION)
    }

    @Test
    fun `common behavior receipt vector verifies with exact binding`() {
        val vector = ObjectMapper().readTree(
            Files.readString(Path.of("..", "..", "conformance", "application-sdk.v1.json")),
        ).path("behavior_receipt")
        val expected = vector.path("expected")
        val expectation = VerificationReceiptExpectation(
            verificationId = expected.path("verification_id").asText(),
            tenantId = expected.path("tenant_id").asText(),
            projectId = expected.path("project_id").asText(),
            environmentId = expected.path("environment_id").asText(),
            collectionInstanceId = expected.path("collection_instance_id").asText(),
            entryId = expected.path("entry_id").asText(),
            generationId = expected.path("generation_id").asText(),
            expectedSizeBytes = expected.path("expected_size_bytes").asLong(),
            contentSha256 = expected.path("content_sha256").asText(),
        )
        assertTrue(verifyVerificationReceipt(vector.path("signed"), vector.path("key_set"), expectation))
        assertFalse(
            verifyVerificationReceipt(
                vector.path("signed"),
                vector.path("key_set"),
                expectation.copy(generationId = vector.path("substitution").path("generation_id").asText()),
            ),
        )
    }

    @Test
    fun `common managed development journey uses the delegated JVM wire core`() {
        val journey = ObjectMapper().readTree(
            Files.readString(Path.of("..", "..", "conformance", "application-sdk.v1.json")),
        ).path("managed_development")
        val ids = journey.path("reference")
        val calls = CopyOnWriteArrayList<String?>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            calls += exchange.requestHeaders.getFirst("Authorization")
            val retry = calls.size == 2
            val status = if (retry) journey.path("retry").path("first_status").asInt() else 200
            val body = ObjectMapper().writeValueAsBytes(
                if (retry) journey.path("retry").path("first_error") else journey.path("positive").path("response"),
            )
            exchange.responseHeaders.add("Content-Type", "application/json")
            if (retry) exchange.responseHeaders.add("Retry-After", "0")
            exchange.sendResponseHeaders(status, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            val baseUrl = "http://127.0.0.1:${server.address.port}"
            val reference = FileReference(
                ids.path("tenant_id").asText(), ids.path("project_id").asText(),
                ids.path("environment_id").asText(), ids.path("collection_instance_id").asText(),
                ids.path("entry_id").asText(),
            )
            val positiveCapability = journey.path("positive").path("capability").asText()
            val positive = AlmiraDataClient(baseUrl, { positiveCapability })
            assertEquals(ids.path("entry_id").asText(), positive.getFileMetadataWithCapability(reference).path("entry_id").asText())

            val refused = AlmiraDataClient(baseUrl, { journey.path("refusal").path("credential").asText() })
            val error = assertFailsWith<com.metamorph.almira.ClientException> {
                refused.getFileMetadataWithCapability(reference)
            }
            assertEquals(journey.path("refusal").path("client_code").asText(), error.code())

            var credentialAttempt = 0
            val capabilities = journey.path("retry").path("capabilities")
            val retrying = AlmiraDataClient(
                baseUrl,
                { capabilities.path(credentialAttempt++).asText() },
                retry = RetryPolicy(2, Duration.ZERO, Duration.ZERO),
            )
            assertEquals(ids.path("entry_id").asText(), retrying.getFileMetadataWithCapability(reference).path("entry_id").asText())
            assertEquals(
                listOf<String?>(
                    "Bearer $positiveCapability",
                    "Bearer ${capabilities.path(0).asText()}",
                    "Bearer ${capabilities.path(1).asText()}",
                ),
                calls,
            )
            assertFalse(journey.path("cleanup").path("applicable").asBoolean())
            assertEquals("read_only_journey", journey.path("cleanup").path("reason").asText())
        } finally {
            server.stop(0)
        }
    }
}
