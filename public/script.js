// public/script.js
function ensureToken() {
    let t = localStorage.getItem("mx_token");
    if (!t) {
        t = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
        localStorage.setItem("mx_token", t);
    }
    return t;
}
const socket = io({ auth: { token: ensureToken() } });

let playerRole = null;  // "X" | "O" | null
let myTurn = false;
let currentRoom = null;

// DOM
const waitingScreen = document.getElementById("waiting");
const gameScreen = document.getElementById("game");
const boardDiv = document.getElementById("board");
const roleDiv = document.getElementById("role");
const statusDiv = document.getElementById("status");
const messageDiv = document.getElementById("message");
const rematchBtn = document.getElementById("rematchBtn");

function setStatus(t){ statusDiv.innerText = t || ""; }
function setMessage(t){ messageDiv.innerText = t || ""; }

function createBoard(){
    boardDiv.innerHTML = "";
    for(let i=0;i<9;i++){
        const cell = document.createElement("div");
        cell.classList.add("cell");
        cell.dataset.index = i;
        cell.addEventListener("click", ()=>playMove(i), {passive:true});
        boardDiv.appendChild(cell);
    }
}

function showWaiting(text="Bir yolcu daha bekleniyor…"){
    waitingScreen.style.display = "block";
    gameScreen.style.display = "none";
    setStatus(text);
    setMessage("");
}
function showGame(){
    waitingScreen.style.display = "none";
    gameScreen.style.display = "block";
    setMessage("");
    createBoard();
}

function updateTurn(currentTurn){
    if (playerRole && currentTurn === playerRole){
        myTurn = true;
        roleDiv.innerText = `Oda: ${currentRoom ?? "-"} | Sen: ${playerRole} (Sıra Sende)`;
    } else {
        myTurn = false;
        roleDiv.innerText = `Oda: ${currentRoom ?? "-"} | Sen: ${playerRole ?? "-"} (Rakip Hamlesi)`;
    }
}

socket.on("joinedRoom", ({roomId})=>{
    currentRoom = roomId;
    setStatus(`Oda: ${roomId} – eşleşme bekleniyor…`);
});

socket.on("playerRole", (role)=>{
    playerRole = role; // "X"|"O"|null
    if (role) roleDiv.innerText = `Oda: ${currentRoom ?? "-"} | Sen: ${role}`;
    else      roleDiv.innerText = `Lobi: Beklemede`;
});

socket.on("waiting", (txt)=> showWaiting(txt));
socket.on("status", (txt)=> setStatus(txt));

socket.on("startGame", ({roomId})=>{
    currentRoom = roomId || currentRoom;
    showGame();
});

socket.on("updateBoard", ({gameBoard, currentTurn})=>{
    const cells = document.querySelectorAll(".cell");
    gameBoard.forEach((val,i)=>{ if(cells[i]) cells[i].innerText = val ?? ""; });
    updateTurn(currentTurn);
});

socket.on("gameOver", ({result, winner})=>{
    if (result==="win") setMessage(`📢 Oyun Bitti – Kazanan: ${winner}`);
    else setMessage("📢 Oyun Bitti – Beraberlik");
    myTurn = false;
    rematchBtn.style.display = (playerRole==="X"||playerRole==="O") ? "inline-block" : "none";
});

socket.on("rematchUpdate", ({votes})=>{
    const need = ["X","O"].filter(r=>!votes.includes(r));
    setStatus(`Tekrar oyuna onay: ${votes.join(", ")||"yok"} | Beklenen: ${need.join(", ")}`);
});

socket.on("rematchStart", ()=>{
    setMessage("");
    rematchBtn.style.display = "none";
    createBoard();
});

function playMove(index){
    if (!playerRole) return;
    if (!myTurn) return;
    socket.emit("play", index);
}

rematchBtn.addEventListener("click", ()=>{
    socket.emit("rematch");
    rematchBtn.style.display = "none";
    setStatus("Tekrar oyuna onayınız alındı. Rakip bekleniyor…");
});
