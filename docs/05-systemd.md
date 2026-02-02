# systemd Service

Example service file:

```ini
[Unit]
Description=GroundControl API
After=network.target

[Service]
Type=simple
User=groundcontrol
WorkingDirectory=/opt/GroundControl
ExecStart=/usr/bin/npm start
Restart=always

[Install]
WantedBy=multi-user.target
