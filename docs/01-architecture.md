# Architecture Overview

GroundControl consists of:

- Node.js backend
- MariaDB / MySQL database
- Bitcoin Core (RPC)
- Firebase Cloud Messaging (FCM)

Flow:

Wallet → GroundControl → Firebase → Device

No BlueWallet infrastructure is used.
