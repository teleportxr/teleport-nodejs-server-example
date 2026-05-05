# SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
#
# SPDX-License-Identifier: MIT

npm install
Remove-Item -Path node_modules/teleportxr -Recurse -Force
New-Item -Path node_modules\teleportxr -ItemType SymbolicLink -Value ..\teleport-nodejs
