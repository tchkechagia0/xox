// server.js
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http, { cors: { origin: "*" } });

app.use(express.static("public"));

/**
 * Tek oda (demo): room-1
 * Refresh koruması için client her bağlantıda "token" gönderir (localStorage).
 * Aynı token = aynı slot (X/O). 3. ve sonrası bekler (lobi).
 */

const ROOM_ID = "room-1";
const room = {
    X: null, // { token, sid }
    O: null, // { token, sid }
    board: Array(9).fill(null),
    turn: "X",
    inGame: false,
    rematchVotes: new Set(), // winner/draw sonrası iki oyuncunun da onayı
};

function getOccupancy() {
    return (room.X ? 1 : 0) + (room.O ? 1 : 0);
}

function boardFull(b) {
    return b.every((v) => v !== null);
}

function winnerOf(b) {
    const L = [
        [0,1,2],[3,4,5],[6,7,8], // satırlar
        [0,3,6],[1,4,7],[2,5,8], // sütunlar
        [0,4,8],[2,4,6]          // çapraz
    ];
    for (const [a,c,d] of L) {
        if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
    }
    return null;
}

function emitState() {
    io.to(ROOM_ID).emit("updateBoard", { gameBoard: room.board, currentTurn: room.turn });
}

function emitRoles(socket) {
    if (room.X && socket.data.token === room.X.token) socket.emit("playerRole", "X");
    else if (room.O && socket.data.token === room.O.token) socket.emit("playerRole", "O");
    else socket.emit("playerRole", null);
}

function startGameIfReady() {
    if (room.X && room.O) {
        room.inGame = true;
        room.board = Array(9).fill(null);
        room.turn = "X";
        room.rematchVotes.clear();
        io.to(ROOM_ID).emit("startGame");
        emitState();
        io.to(ROOM_ID).emit("status", "Oyun başladı. X başlıyor.");
    }
}

io.on("connection", (socket) => {
    // refresh koruması: token ile kimlik
    const token = socket.handshake.auth?.token || null;
    socket.data.token = token;

    // Odaya kat
    socket.join(ROOM_ID);

    // Slot tahsisi (token eşleşirse yerine oturt; yeni ise boş yere yerleştir)
    const takenByToken =
        (room.X && room.X.token === token) ? "X" :
            (room.O && room.O.token === token) ? "O" : null;

    if (!takenByToken) {
        // yeni biri: uygun slot var mı?
        if (!room.X) {
            room.X = { token, sid: socket.id };
        } else if (!room.O) {
            room.O = { token, sid: socket.id };
        } else {
            // dolu → lobiye bilgi ver
            socket.emit("waiting", "Oyun dolu. Lütfen bekleyin…");
        }
    } else {
        // refresh: SID güncelle
        if (takenByToken === "X") room.X.sid = socket.id;
        if (takenByToken === "O") room.O.sid = socket.id;
    }

    emitRoles(socket);

    // Oda durumu bildir
    const occ = getOccupancy();
    if (occ === 1) {
        socket.emit("status", "Bir yolcu daha bekleniyor…");
    } else if (occ >= 2) {
        // iki oyuncu varsa oyunu başlat/hatırlat
        startGameIfReady();
    }

    // Lobiye sürekli durum iletisi
    if (occ >= 2 && !(takenByToken || !room.X || !room.O)) {
        socket.emit("waiting", "Oyun devam ediyor. Lütfen bitmesini bekleyin…");
        socket.emit("status", "Lobi: Oyun sürüyor.");
    }

    // Hamle
    socket.on("play", (index) => {
        // sadece X/O hamle atabilir
        const role =
            room.X && room.X.token === socket.data.token ? "X" :
                room.O && room.O.token === socket.data.token ? "O" : null;

        if (!role) return; // lobi
        if (!room.inGame) return;
        if (role !== room.turn) return;
        if (room.board[index] !== null) return;

        room.board[index] = role;
        room.turn = room.turn === "X" ? "O" : "X";

        const w = winnerOf(room.board);
        if (w) {
            io.to(ROOM_ID).emit("updateBoard", { gameBoard: room.board, currentTurn: room.turn });
            io.to(ROOM_ID).emit("gameOver", { result: "win", winner: w });
            io.to(ROOM_ID).emit("status", `Oyun bitti. Kazanan: ${w}`);
            room.inGame = false;
            room.rematchVotes.clear();
            return;
        }
        if (boardFull(room.board)) {
            io.to(ROOM_ID).emit("updateBoard", { gameBoard: room.board, currentTurn: room.turn });
            io.to(ROOM_ID).emit("gameOver", { result: "draw" });
            io.to(ROOM_ID).emit("status", "Oyun bitti. Beraberlik.");
            room.inGame = false;
            room.rematchVotes.clear();
            return;
        }

        emitState();
    });

    // Rematch (aynı ikili)
    socket.on("rematch", () => {
        const role =
            room.X && room.X.token === socket.data.token ? "X" :
                room.O && room.O.token === socket.data.token ? "O" : null;
        if (!role) return;
        room.rematchVotes.add(role);
        io.to(ROOM_ID).emit("rematchUpdate", { votes: Array.from(room.rematchVotes) });

        if (room.rematchVotes.has("X") && room.rematchVotes.has("O")) {
            // iki oyuncu da onayladı
            room.board = Array(9).fill(null);
            room.turn = "X";
            room.inGame = true;
            room.rematchVotes.clear();
            io.to(ROOM_ID).emit("rematchStart");
            emitState();
            io.to(ROOM_ID).emit("status", "Yeni oyun başladı. X başlıyor.");
        }
    });

    socket.on("disconnect", () => {
        // Sekme kapanırsa slot’u hemen boşaltma; demo stabilitesi için boşaltıyoruz,
        // ama token kalacağı için geri girince aynı role atanacak (auth.token aynıysa).
        if (room.X && room.X.sid === socket.id) {
            room.X.sid = null; // token duruyor
            io.to(ROOM_ID).emit("status", "X bağlantısı koptu. Yeniden bağlanabilir.");
        } else if (room.O && room.O.sid === socket.id) {
            room.O.sid = null;
            io.to(ROOM_ID).emit("status", "O bağlantısı koptu. Yeniden bağlanabilir.");
        }

        // Her iki slot da tamamen boşaldıysa sıfırla (temizlik)
        if ((room.X && !room.X.sid) && (room.O && !room.O.sid)) {
            room.inGame = false;
            room.board = Array(9).fill(null);
            room.turn = "X";
            room.rematchVotes.clear();
            io.to(ROOM_ID).emit("status", "Oyun sıfırlandı. Yeni oyuncular bekleniyor.");
        }
    });
});

http.listen(3000, () => {
    console.log("Metro-XOX sunucusu: http://localhost:3000");
});
