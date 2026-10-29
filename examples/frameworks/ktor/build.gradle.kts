plugins {
    kotlin("jvm") version "2.3.21"
    application
}

allprojects { repositories { mavenCentral() } }

dependencies {
    implementation(project(":kotlin"))
    implementation("io.ktor:ktor-server-core-jvm:3.6.0")
    implementation("io.ktor:ktor-server-netty-jvm:3.6.0")
    implementation("io.ktor:ktor-server-content-negotiation-jvm:3.6.0")
    implementation("io.ktor:ktor-serialization-jackson-jvm:3.6.0")
}

application { mainClass = "example.ApplicationKt" }
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 } }
tasks.withType<JavaCompile>().configureEach { options.release = 17 }
