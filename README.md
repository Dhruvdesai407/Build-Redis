-----

# ✨ My Redis Clone: From Zero Backend to Replication Architect \! 🚀

Ever wondered how lightning-fast apps are built? I did. So I built a **Redis clone from scratch**, diving headfirst into TypeScript with zero prior backend experience. This project isn't just code; it's the story of my transformation into a backend builder. 🤯

Dive in to see how I cracked the code of distributed data stores and learned to speak their secret language\! 👇

-----

## 🎯 Table of Contents

  * [🔥 Core Features](https://github.com/Dhruvdesai407/Build-Redis?tab=readme-ov-file#-core-features)
  * [💡 My Backend & TypeScript Journey](https://github.com/Dhruvdesai407/Build-Redis?tab=readme-ov-file#-my-backend--typescript-journey)
  * [🚀 Run Your Own Redis Clone\!](https://github.com/Dhruvdesai407/Build-Redis?tab=readme-ov-file#-run-your-own-redis-clone)
      * [1. Clone & Setup](https://github.com/Dhruvdesai407/Build-Redis?tab=readme-ov-file#1-clone--setup)
      * [2. Prepare RDB (using Valkey)](https://github.com/Dhruvdesai407/Build-Redis?tab=readme-ov-file#2-prepare-rdb-using-valkey)
      * [3. Launch Master & Replica](https://github.com/Dhruvdesai407/Build-Redis?tab=readme-ov-file#3-launch-master--replica)

-----

## 🔥 Core Features

My server mirrors essential Redis capabilities:

  * **Key-Value Blitz (GET, SET):** Fast data storage and retrieval. 🚀💾
  * **Server Diagnostics (INFO):** Get operational insights, especially for replication. 🧠📊
  * **Data Immortality (RDB Persistence):** Loads data from `dump.rdb` on startup. ✅
  * **Seamless Master-Replica Replication:** Flawlessly executes the full handshake:
      * `PING/PONG` 🤝
      * `REPLCONF` (capabilities exchange) 🗣️
      * `PSYNC ? -1` (full resync request) 🔄
      * `+FULLRESYNC` (master's command with ID & offset) 🆔
      * Initial RDB Snapshot Transfer 📦✨

-----

## 💡 My Backend & TypeScript Journey

This project was a backend bootcamp that transformed my skills:

  * **Backend Unleashed:** Built core server logic and handled raw TCP network communication. 🌉
  * **TypeScript Conquered:** My first deep dive into TS for robust, scalable code. My new superpower\! 🦸‍♀️
  * **Protocol Alchemist:** Manually parsed and crafted Redis's RESP messages. 🤫
  * **State Machine Maestro:** Mastered complex, multi-step processes via the replication handshake. 🧩
  * **Buffering Ninja:** Efficiently reassembled fragmented network packets. 🧮
  * **Demystifying Distributed Systems:** Gained deep insights into master-replica architectures. 🏛️

Every challenge fueled my growth. Every bug, a battle won. This project didn't just teach me; it **transformed me**. 🌟

-----

## 🚀 Run Your Own Redis Clone\!

Follow these simple steps. Just copy-paste each block into your terminal\!

### 1\. Clone & Setup

```bash
git clone https://github.com/Dhruvdesai407/Build-Redis.git
cd Build-Redis
npm install
tsc # Creates dist/main.js
```

### 2\. Prepare RDB (using Valkey)

Your clone loads data from `dump.rdb`. We'll use **Valkey** to create it.

**First, install Valkey:**

  * **Debian/Ubuntu:** `sudo apt update && sudo apt install valkey-server valkey-tools -y`
  * **macOS (Homebrew):** `brew install valkey`
  * **Other OS:** See [valkey.io/topics/installation/](https://valkey.io/topics/installation/)

**Now, create `dump.rdb` (requires two temporary terminals):**

**Terminal 1 (Valkey Server):**

```bash
mkdir -p ./data/valkey_temp
echo "Starting temporary Valkey server (port 6379)..."
valkey-server --port 6379 --dir ./data/valkey_temp --dbfilename dump.rdb --save ""
# KEEP THIS OPEN! Press Ctrl+C only when instructed later.
```

**Terminal 2 (Valkey CLI):**

```bash
echo "Connecting to Valkey CLI..."
valkey-cli -p 6379
# Inside valkey-cli, add some data (e.g., SET mykey "Hello!", SAVE, EXIT)
# Example commands:
# SET mykey "Hello from Valkey!"
# LPUSH mylist "item1" "item2" "item3"
# SAVE
# EXIT
```

**Back in Terminal 1:**

```bash
# After you SAVE & EXIT from Valkey CLI in Terminal 2,
# press Ctrl+C here to stop valkey-server.
mv ./data/valkey_temp/dump.rdb ./data/dump.rdb # Move RDB to ./data/
rmdir ./data/valkey_temp # Clean up
echo "dump.rdb created and moved to ./data/."
```

### 3\. Launch Master & Replica

**Terminal 1 (Master Server):**

```bash
# Open a NEW terminal
node dist/main.js --dir ./data --dbfilename dump.rdb --port 6380
```

**Terminal 2 (Replica Server):**

```bash
# Open ANOTHER NEW terminal
node dist/main.js --dir ./data --dbfilename dump.rdb --port 6381 --replicaof 127.0.0.1 6380
```

-----

Watch the magic\! 🎉 You'll see the full replication handshake and a perfectly synchronized replica.

This project is about the **incredible journey of learning, perseverance, and becoming a true backend builder.** Explore the code, contribute, or drop a star if it inspires you\! ⭐ Let's build amazing things\!
