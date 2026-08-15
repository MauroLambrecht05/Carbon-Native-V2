# Carbon Cloud — Windows build worker.
#
# NEEDS A WINDOWS DOCKER HOST. Windows containers cannot run on the Linux
# daemon the other two Dockerfiles in this directory target, and this repo's
# dev sandbox has no Windows Docker host to build or run this against —
# written to the same standard as worker-linux.Dockerfile, but unverified.
# Verify on a real Windows runner before relying on it.
#
# Needs: Rust (ensureRuntime compiles carbon-mini/blitz from source on first
# use), Bun, git, and the two Windows packaging toolchains
# solutions/capabilities/packaging/infrastructure/builders/{nsis,wix}.ts
# invoke — NSIS and the WiX v4 CLI. signtool.exe ships with the Windows SDK;
# the smallest redistributable path is the standalone SDK installer below
# rather than the full Visual Studio image.

FROM mcr.microsoft.com/windows/servercore:ltsc2022

ARG BUN_VERSION=1.3.10
ARG RUST_VERSION=1.88.0
ARG NSIS_VERSION=3.09
ARG WIX_VERSION=4.0.5

SHELL ["powershell", "-NoProfile", "-Command"]

# Rust
RUN Invoke-WebRequest -Uri https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe -OutFile rustup-init.exe; \
    .\rustup-init.exe -y --default-toolchain $env:RUST_VERSION --profile minimal; \
    Remove-Item rustup-init.exe
ENV PATH="C:\Users\ContainerAdministrator\.cargo\bin;$env:PATH"

# Bun
RUN Invoke-WebRequest -Uri https://github.com/oven-sh/bun/releases/download/bun-v$env:BUN_VERSION/bun-windows-x64.zip -OutFile bun.zip; \
    Expand-Archive bun.zip -DestinationPath C:\bun; \
    Remove-Item bun.zip
ENV PATH="C:\bun\bun-windows-x64;$env:PATH"

# NSIS (makensis)
RUN Invoke-WebRequest -Uri https://sourceforge.net/projects/nsis/files/NSIS%203/$env:NSIS_VERSION/nsis-$env:NSIS_VERSION.zip/download -OutFile nsis.zip; \
    Expand-Archive nsis.zip -DestinationPath C:\nsis; \
    Remove-Item nsis.zip
ENV PATH="C:\nsis\nsis-3.09;$env:PATH"

# WiX v4 CLI (needs the .NET SDK it's a dotnet tool for — see WiX v4 docs)
RUN Invoke-WebRequest -Uri https://dot.net/v1/dotnet-install.ps1 -OutFile dotnet-install.ps1; \
    .\dotnet-install.ps1 -Channel 8.0 -InstallDir C:\dotnet; \
    Remove-Item dotnet-install.ps1
ENV PATH="C:\dotnet;$env:PATH"
RUN dotnet tool install --global wix --version $env:WIX_VERSION
ENV PATH="C:\Users\ContainerAdministrator\.dotnet\tools;$env:PATH"

# git
RUN Invoke-WebRequest -Uri https://github.com/git-for-windows/git/releases/download/v2.47.0.windows.1/MinGit-2.47.0-64-bit.zip -OutFile git.zip; \
    Expand-Archive git.zip -DestinationPath C:\git; \
    Remove-Item git.zip
ENV PATH="C:\git\cmd;$env:PATH"

WORKDIR C:\app
COPY . .

ENV WORK_DIR="C:\carbon-cloud-worker"
CMD ["bun", "products/carbon-cloud/composition/worker-windows.ts"]
