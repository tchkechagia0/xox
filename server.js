// server.js  (Multi-room, 2 kişilik odalar, lobby, refresh korumalı)
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");

// Render / Railway vb. için PORT'u kullan
const PORT = process.env.PORT || 3000;

const io = new Server(http, { cors: { origin: "*" } });
app.use(express.static("public"));

// ====== ODA YAPISI ======
// Her oda: X, O, board, turn, inGame, rematchVotes (Set), lastActive
const rooms = {};                // { "room-1": {...}, ... }
const MAX_ROOMS = 5;             // Ücretsiz planda ~5 paralel oyun güvenli
const ROOM_CAPACITY = 2;         // 2 kişilik (X vs O)

// Token -> roomId eşlemesi (refresh'te aynı odaya dönsün)
const tokenToRoom = new Map();

// Yardımcılar
const now = () => Date.now();
const blankBoard = () => Array(9).fill(null);
const winOf = (b) => {
    const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const [a,c,d] of L) if (b[a] && b[a]===b[c] && b[a]===b[d]) return b[a];
    return null;
};
const full = (b) => b.every(v=>v!==null);

// Oda oluştur
function createRoom(id){
    rooms[id] = {
        id,
        X: null,                 // { token, sid }
        O: null,                 // { token, sid }
        board: blankBoard(),
        turn: "X",
        inGame: false,
        rematchVotes: new Set(),
        lastActive: now()
    };
    return rooms[id];
}

// Uygun odayı bul/oluştur
function findOrCreateRoomForToken(token){
    // Token daha önce bir odaya girmişse oraya döndür
    const prior = tokenToRoom.get(token);
    if (prior && rooms[prior]) return rooms[prior];

    // Boş/eksik oyunculu bir oda bul
    for (const r of Object.values(rooms)){
        const occ = (r.X?1:0) + (r.O?1:0);
        if (occ < ROOM_CAPACITY) return r;
    }
    // Gerekirse yeni oda aç (limit içinde)
    const existing = Object.keys(rooms).length;
    if (existing < MAX_ROOMS){
        const id = `room-${existing+1}`;
        return createRoom(id);
    }
    return null; // Lobby'de bekleteceğiz
}

function startGame(room){
    if (room.X && room.O){
        room.inGame = true;
        room.board = blankBoard();
        room.turn = "X";
        room.rematchVotes.clear();
        io.to(room.id).emit("startGame", { roomId: room.id });
        io.to(room.id).emit("status", `Oda: ${room.id} – Oyun başladı. X başlıyor.`);
        emitState(room);
    }
}

function emitState(room){
    io.to(room.id).emit("updateBoard", { gameBoard: room.board, currentTurn: room.turn });
    room.lastActive = now();
}

io.on("connection", (socket)=>{
    const token = socket.handshake.auth?.token || null;
    socket.data.token = token;

    // Oda belirle
    let room = findOrCreateRoomForToken(token);

    if (!room){
        // Tüm odalar dolu → lobby bekleme
        socket.emit("waiting", "Tüm odalar dolu. Lütfen bekleyiniz…");
        socket.emit("status", "Lobi: Uygun oda bekleniyor.");
        return;
    }

    // Odaya kat
    socket.join(room.id);
    socket.data.roomId = room.id;
    tokenToRoom.set(token, room.id);
    socket.emit("joinedRoom", { roomId: room.id });

    // Slot ataması (refresh ise SID güncelle)
    if (room.X && room.X.token === token){
        room.X.sid = socket.id;
        socket.emit("playerRole", "X");
    } else if (room.O && room.O.token === token){
        room.O.sid = socket.id;
        socket.emit("playerRole", "O");
    } else if (!room.X){
        room.X = { token, sid: socket.id };
        socket.emit("playerRole", "X");
    } else if (!room.O){
        room.O = { token, sid: socket.id };
        socket.emit("playerRole", "O");
    } else {
        // Oda doluysa; başka oda deneyelim (tekrar çağır)
        // (Nadir: aynı anda iki kişi dolduysa)
        socket.leave(room.id);
        const alt = findOrCreateRoomForToken(token);
        if (!alt){ // Tamamen dolu
            socket.emit("waiting", "Tüm odalar dolu. Lütfen bekleyiniz…");
            socket.emit("status", "Lobi: Uygun oda bekleniyor.");
            return;
        }
        room = alt;
        socket.join(room.id);
        socket.data.roomId = room.id;
        tokenToRoom.set(token, room.id);
        socket.emit("joinedRoom", { roomId: room.id });
        if (!room.X){ room.X = { token, sid: socket.id }; socket.emit("playerRole","X"); }
        else if (!room.O){ room.O = { token, sid: socket.id }; socket.emit("playerRole","O"); }
    }

    // Oda durumu
    const occ = (room.X?1:0)+(room.O?1:0);
    if (occ === 1){
        socket.emit("status", `Oda: ${room.id} – Bir yolcu daha bekleniyor…`);
    } else if (occ === 2){
        startGame(room);
    }

    // Hamle
    socket.on("play", (index)=>{
        const rid = socket.data.roomId; if (!rid) return;
        const r = rooms[rid]; if (!r || !r.inGame) return;

        const role =
            (r.X && r.X.token===socket.data.token) ? "X" :
                (r.O && r.O.token===socket.data.token) ? "O" : null;
        if (!role) return;
        if (role !== r.turn) return;
        if (r.board[index] !== null) return;

        r.board[index] = role;
        r.turn = (r.turn==="X") ? "O" : "X";

        const w = winOf(r.board);
        if (w){
            emitState(r);
            io.to(r.id).emit("gameOver", { result:"win", winner:w });
            io.to(r.id).emit("status", `Oda: ${r.id} – Oyun bitti. Kazanan: ${w}`);
            r.inGame = false; r.rematchVotes.clear();
            return;
        }
        if (full(r.board)){
            emitState(r);
            io.to(r.id).emit("gameOver", { result:"draw" });
            io.to(r.id).emit("status", `Oda: ${r.id} – Oyun bitti. Beraberlik.`);
            r.inGame = false; r.rematchVotes.clear();
            return;
        }
        emitState(r);
    });

    // Rematch
    socket.on("rematch", ()=>{
        const rid = socket.data.roomId; if (!rid) return;
        const r = rooms[rid]; if (!r) return;
        const role =
            (r.X && r.X.token===socket.data.token) ? "X" :
                (r.O && r.O.token===socket.data.token) ? "O" : null;
        if (!role) return;

        r.rematchVotes.add(role);
        io.to(r.id).emit("rematchUpdate", { votes: Array.from(r.rematchVotes) });
        if (r.rematchVotes.has("X") && r.rematchVotes.has("O")){
            r.board = blankBoard();
            r.turn = "X";
            r.inGame = true;
            r.rematchVotes.clear();
            io.to(r.id).emit("rematchStart");
            emitState(r);
            io.to(r.id).emit("status", `Oda: ${r.id} – Yeni oyun başladı. X başlıyor.`);
        }
    });

    // Disconnect (slot'ta token kalsın; yeniden bağlanabilir)
    socket.on("disconnect", ()=>{
        const rid = socket.data.roomId; if (!rid) return;
        const r = rooms[rid]; if (!r) return;

        if (r.X && r.X.sid === socket.id){ r.X.sid = null; io.to(r.id).emit("status", `Oda: ${r.id} – X bağlantısı koptu.`); }
        if (r.O && r.O.sid === socket.id){ r.O.sid = null; io.to(r.id).emit("status", `Oda: ${r.id} – O bağlantısı koptu.`); }

        // Oda tamamen boşaldıysa belirli süre sonra temizlenebilir (opsiyonel)
        // Burada sadece lastActive güncelliyoruz.
        r.lastActive = now();
    });
});

http.listen(PORT, () => {
    console.log(`Metro-XOX (multi-room) listening on http://localhost:${PORT}`);
});
