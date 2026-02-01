# GroundControl Ops Notes

## systemd services
- groundcontrol-api
- groundcontrol-sender
- groundcontrol-mempool
- groundcontrol-blockprocessor

Restart all:
sudo systemctl restart groundcontrol-api groundcontrol-sender groundcontrol-mempool groundcontrol-blockprocessor

Follow logs:
sudo journalctl -u groundcontrol-api -f
sudo journalctl -u groundcontrol-sender -f
sudo journalctl -u groundcontrol-mempool -f
sudo journalctl -u groundcontrol-blockprocessor -f

## DB state
Key used by blockprocessor:
- key_value.LAST_PROCESSED_BLOCK

If confirmations stop, verify it's not ahead of chain tip.
