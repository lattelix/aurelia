plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.lattelix.aurelia.source"
    compileSdk = 37
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) } }

dependencies {
    api("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.11.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.github.MetrolistGroup.innertubex:innertubex:v0.11.2")
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.4.21")
    implementation("io.ktor:ktor-client-android:3.6.0")
    implementation("io.ktor:ktor-client-content-negotiation:3.6.0")
    implementation("io.ktor:ktor-serialization-kotlinx-json:3.6.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("io.ktor:ktor-client-mock:3.6.0")
}
