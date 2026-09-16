@rem
@rem JARVIS Companion Gradle wrapper launcher (Windows).
@rem Requires a JDK 17+ on the PATH. Dispatches to the Gradle distribution
@rem pinned in gradle/wrapper/gradle-wrapper.properties.
@rem
@if "%DEBUG%"=="" @echo off
@rem Use forward slash-friendly dirs; locate script root.
setlocal
set DIRNAME=%~dp0

if "%DIRNAME%"=="" set DIRNAME=.
set APP_BASE_NAME=%~n0
set APP_HOME=%DIRNAME%

set DEFAULT_JVM_OPTS="-Xmx2048m" "-Dfile.encoding=UTF-8"

@rem Find java
if defined JAVA_HOME goto findJavaFromJavaHome
set JAVA_EXE=java.exe
%JAVA_EXE% -version >NUL 2>&1
if "%ERRORLEVEL%" == "0" goto execute
echo.
echo ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.
echo Please set the JAVA_HOME variable to a JDK 17+ installation directory.
echo.
exit /b 1

:findJavaFromJavaHome
set JAVA_HOME=%JAVA_HOME:"=%
set JAVA_EXE=%JAVA_HOME%\bin\java.exe
if exist "%JAVA_EXE%" goto execute
echo.
echo ERROR: JAVA_HOME is set to an invalid directory: %JAVA_HOME%
echo Please set the JAVA_HOME variable to a JDK 17+ installation directory.
echo.
exit /b 1

:execute
set CLASSPATH=%APP_HOME%\gradle\wrapper\gradle-wrapper.jar
if not exist "%CLASSPATH%" (
    echo ERROR: %CLASSPATH% is missing. Restore gradle/wrapper/gradle-wrapper.jar
    exit /b 1
)
"%JAVA_EXE%" %DEFAULT_JVM_OPTS% -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*
if "%ERRORLEVEL%" == "0" exit /b 0
exit /b 1