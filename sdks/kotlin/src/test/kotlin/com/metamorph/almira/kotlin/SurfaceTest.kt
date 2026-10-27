package com.metamorph.almira.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals

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
}
