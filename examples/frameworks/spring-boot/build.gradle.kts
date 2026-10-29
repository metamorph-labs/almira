plugins {
    java
    id("org.springframework.boot") version "4.1.2"
}

allprojects { repositories { mavenCentral() } }

dependencies {
    implementation(project(":java"))
    implementation("org.springframework.boot:spring-boot-starter-web:4.1.2")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
tasks.withType<JavaCompile>().configureEach { options.release = 17 }
