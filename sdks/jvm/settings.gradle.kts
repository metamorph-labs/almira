rootProject.name = "almira-jvm"

include("java", "kotlin")
project(":java").projectDir = file("../java")
project(":kotlin").projectDir = file("../kotlin")
