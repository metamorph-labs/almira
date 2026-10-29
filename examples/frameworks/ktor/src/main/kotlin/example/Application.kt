package example

import com.metamorph.almira.kotlin.AlmiraDataClient
import com.metamorph.almira.kotlin.FileReference
import com.metamorph.almira.kotlin.RetryPolicy
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.jackson.jackson
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import java.time.Duration

fun main() {
    val client = AlmiraDataClient(
        baseUrl = required("ALMIRA_BASE_URL"),
        capability = { required("ALMIRA_CAPABILITY") },
        retry = RetryPolicy(3, Duration.ofMillis(100), Duration.ofSeconds(2)),
    )
    embeddedServer(Netty, port = 8080) {
        install(ContentNegotiation) { jackson() }
        routing {
            get("/files/{entryId}") {
                if (call.request.headers["X-App-User"].isNullOrBlank()) {
                    call.respond(HttpStatusCode.Forbidden, mapOf("code" to "ALMIRA_EXAMPLE_FORBIDDEN"))
                    return@get
                }
                val entryId = call.parameters["entryId"] ?: return@get call.respond(HttpStatusCode.BadRequest)
                call.respond(client.getFileMetadataWithCapability(FileReference(
                    required("ALMIRA_TENANT_ID"), required("ALMIRA_PROJECT_ID"),
                    required("ALMIRA_ENVIRONMENT_ID"), required("ALMIRA_COLLECTION_ID"), entryId,
                )))
            }
        }
    }.start(wait = true)
}

private fun required(name: String): String =
    System.getenv(name)?.takeIf { it.isNotBlank() } ?: error("$name is required")
