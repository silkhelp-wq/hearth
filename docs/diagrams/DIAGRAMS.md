# Hearth — Diagrams

> **Audience:** all technical audiences · **Prerequisites:** none · **Time:** visual reference · **Applies to:** v0.6.x

Visual reference for Hearth's architecture and key flows. These use
[Mermaid](https://mermaid.js.org/), which GitHub renders natively in Markdown.
For the authoritative ASCII topology and prose, see
[`../ARCHITECTURE.md`](../ARCHITECTURE.md); this document is the visual
companion.

---

## 1. System architecture (SFU topology)

```mermaid
graph TB
    subgraph Clients["Clients (Electron desktop apps)"]
        CA["Client A"]
        CB["Client B"]
        CC["Client C"]
        CD["Client ... J"]
    end

    subgraph Host["HOST machine"]
        subgraph Server["Hearth server (Node.js)"]
            EX["Express :4443/tcp<br/>/health /info /speedtest"]
            SIO["Socket.IO :4443/tcp<br/>signaling · rooms · control"]
            SFU["mediasoup SFU<br/>WebRtcServer :44444 udp+tcp<br/>1 worker · router / channel"]
            DB[("SQLite<br/>WAL + FTS5")]
        end
    end

    CA -.->|Socket.IO signaling| SIO
    CB -.->|Socket.IO signaling| SIO
    CC -.->|Socket.IO signaling| SIO
    CD -.->|Socket.IO signaling| SIO

    CA ==SRTP media==> SFU
    CB ==SRTP media==> SFU
    CC ==SRTP media==> SFU
    CD ==SRTP media==> SFU

    SIO --- SFU
    SIO --- DB

    classDef client fill:#1f3a2e,stroke:#7ac943,color:#fff
    classDef server fill:#2a2438,stroke:#b389f0,color:#fff
    classDef store fill:#3a2e1f,stroke:#d9b45a,color:#fff
    class CA,CB,CC,CD client
    class EX,SIO,SFU server
    class DB store
```

Every participant uploads each stream **once**; the SFU forwards copies to
everyone else. Host **upload** is the shared ceiling.

---

## 2. Network connectivity models

```mermaid
graph LR
    subgraph Private["Private model (recommended)"]
        direction TB
        PA["Client"] -->|"100.x.y.z<br/>WireGuard mesh"| PT["Tailscale tailnet"]
        PT --> PS["Hearth server<br/>(no public exposure)"]
    end

    subgraph Public["Public model"]
        direction TB
        UA["Client"] -->|"https://hearth.example.com"| RP["TLS reverse proxy<br/>(Caddy/nginx) :443→:4443"]
        RP --> US["Hearth server"]
        UA -->|"SRTP :44444 direct"| US
    end

    classDef c fill:#1f3a2e,stroke:#7ac943,color:#fff
    classDef s fill:#2a2438,stroke:#b389f0,color:#fff
    class PA,UA c
    class PS,US,RP,PT s
```

In the private model nothing is exposed publicly. In the public model, TLS
fronts **signaling only** — media (44444) goes direct to the instance.

---

## 3. Joining a voice channel (sequence)

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Socket.IO
    participant M as mediasoup SFU
    participant P as Peers

    C->>S: connect (device token)
    S->>S: register / load user
    C->>S: get router RTP capabilities
    S-->>C: capabilities
    C->>C: load mediasoup Device
    C->>S: create send + recv transports
    S->>M: create WebRTC transports
    M-->>C: transport params
    C->>M: DTLS handshake (:44444)
    C->>S: produce mic
    S->>M: create producer
    S->>P: notify new producer
    P->>M: consume producer
    M-->>P: forwarded stream
    Note over M,P: AudioLevelObserver drives<br/>dominant-speaker UI
```

---

## 4. Screen share on Wayland (single-portal flow)

```mermaid
sequenceDiagram
    participant U as User
    participant R as Renderer
    participant Main as Electron main
    participant Portal as OS portal
    participant M as mediasoup

    U->>R: click Share
    R->>R: show quality/codec only<br/>(no in-app source list on Wayland)
    U->>R: click "Go live"
    R->>Main: getDisplayMedia
    Main->>Portal: open picker (ONCE)
    Portal-->>U: choose screen/window
    U-->>Portal: selection
    Portal-->>Main: single source
    Main-->>R: source for libwebrtc
    R->>M: produce screen track
    M->>M: consumers request top temporal layer
    Note over R,M: One portal prompt = no AbortError
```

---

## 5. Focus mode (watch one stream)

```mermaid
stateDiagram-v2
    [*] --> Grid: multiple streams
    Grid --> Focused: click a tile
    Focused --> Focused: click another tile<br/>(switch: resume + keyframe)
    Focused --> Grid: click focused tile<br/>(unfocus: resume all)

    note right of Focused
        Focused tile fills the stage.
        Other video consumers are
        server-paused (zero packets).
        Audio never pauses.
    end note
```

---

## 6. Auto-update flow (client & server)

```mermaid
graph TB
    subgraph Client["Client auto-update"]
        direction TB
        C1["Installed app"] --> C2{"Check for updates<br/>(Settings → Audio)"}
        C2 -->|newer release exists| C3["Download from Releases"]
        C3 --> C4["Restart into new version"]
        C2 -->|up to date| C5["No action"]
    end

    subgraph Server["Server auto-update"]
        direction TB
        S1["Server monitor<br/>(Settings → Server)"] --> S2{"Check repo<br/>(needs update token)"}
        S2 -->|newer release| S3["Report 'update available'"]
        S3 --> S4["Operator re-runs install<br/>+ restart (data preserved)"]
        S2 -->|current| S5["Report 'up to date'"]
    end

    classDef c fill:#1f3a2e,stroke:#7ac943,color:#fff
    classDef s fill:#2a2438,stroke:#b389f0,color:#fff
    class C1,C2,C3,C4,C5 c
    class S1,S2,S3,S4,S5 s
```

---

## 7. Permission resolution

```mermaid
graph LR
    U["Member"] --> R["Role assignments"]
    R --> B["Base permission bits"]
    B --> O["Per-channel<br/>allow/deny overwrites"]
    O --> E["Effective permissions"]
    E --> D{"Action allowed?"}
    D -->|bit set| Y["✅ permit"]
    D -->|bit clear| N["❌ deny"]

    classDef n fill:#2a2438,stroke:#b389f0,color:#fff
    class U,R,B,O,E,D,Y,N n
```

Permissions are a bitfield (VIEW_CHANNEL … MANAGE_EMOJIS). Note the deliberate
split of `CREATE_CHANNELS` from `MANAGE_CHANNELS`: everyone creates, Admins
delete.

---

## 8. Ownership lifecycle

```mermaid
stateDiagram-v2
    [*] --> Unclaimed: fresh database
    Unclaimed --> Claimed: enter claim code<br/>(Settings → Server)
    Claimed --> Transferred: owner transfers<br/>to another member
    Transferred --> Claimed: new owner holds it
    Claimed --> Unclaimed: host runs<br/>hearth-reclaim-owner
    Transferred --> Unclaimed: host runs<br/>hearth-reclaim-owner

    note right of Unclaimed
        Server prints a claim code
        on boot only when unclaimed.
    end note
    note right of Claimed
        Ownership binds to the
        claiming client's device
        identity.
    end note
```

The host can **always** recover ownership from the machine, regardless of
client state — the escape hatch for a stranded owner.

---

## 9. Deployment topology (cloud, single instance)

```mermaid
graph TB
    subgraph Internet
        Cl["Clients"]
    end

    subgraph Cloud["Cloud provider"]
        subgraph FW["Firewall / security group"]
            direction TB
            LB["(optional) LB / proxy<br/>TCP 443→4443 signaling only"]
            VM["Instance (public IP = HEARTH_ANNOUNCED_IP)"]
        end
        Disk[("Persistent disk<br/>HEARTH_DATA_DIR")]
    end

    Cl -->|"signaling 443/4443"| LB
    LB --> VM
    Cl -->|"media 44444 udp+tcp DIRECT"| VM
    VM --- Disk

    classDef c fill:#1f3a2e,stroke:#7ac943,color:#fff
    classDef s fill:#2a2438,stroke:#b389f0,color:#fff
    classDef d fill:#3a2e1f,stroke:#d9b45a,color:#fff
    class Cl c
    class VM,LB s
    class Disk d
```

**Critical:** media (44444) bypasses the load balancer and goes direct to the
instance; only signaling is proxied. `HEARTH_ANNOUNCED_IP` must be the public
IP.

---

## 10. Data model (core tables)

```mermaid
erDiagram
    users ||--o{ user_roles : has
    roles ||--o{ user_roles : grants
    channels ||--o{ overwrites : scopes
    roles ||--o{ overwrites : targets
    channels ||--o{ messages : contains
    users ||--o{ messages : authors
    messages ||--o{ reactions : receives
    users ||--o{ reactions : adds
    messages ||--o{ pins : pinned
    channels ||--o{ read_state : tracks
    users ||--o{ read_state : per-user
    messages ||--o{ message_links : references
    message_links ||--o{ link_previews : renders

    users {
        string id PK
        string device_token
        string name
        bool is_owner
    }
    channels {
        string id PK
        string name
        string type
    }
    messages {
        string id PK
        string channel_id FK
        string author_id FK
        text content
        int created_at
    }
    roles {
        string id PK
        string name
        int permissions
        int position
    }
```

Simplified — see [`../engineering/ENGINEERING_GUIDE.md`](../engineering/ENGINEERING_GUIDE.md)
§3.4 for the full table list. Chat lives in SQLite (WAL + FTS5) and prunes
oldest-first at the storage cap.
