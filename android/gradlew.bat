@echo off
title Battlegrid Android Build
set DIRNAME=%~dp0
set CLASSPATH=%DIRNAME%gradle\wrapper\gradle-wrapper.jar

if not exist "%CLASSPATH%" (
    echo Downloading Gradle wrapper jar...
    mkdir "%DIRNAME%gradle\wrapper" 2>nul
    powershell -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/gradle/gradle/v8.5.0/gradle/wrapper/gradle-wrapper.jar' -OutFile '%CLASSPATH%'"
)

java -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*
