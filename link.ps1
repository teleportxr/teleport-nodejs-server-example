npm install
Remove-Item -Path node_modules/teleportxr -Recurse -Force
New-Item -Path node_modules\teleportxr -ItemType SymbolicLink -Value ..\teleport-nodejs
