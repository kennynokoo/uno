const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const playerSockets = new Map();

class GameRoom {
    constructor(roomId, io) {
        this.roomId = roomId;
        this.io = io;
        this.players = [];
        this.gameState = null;
        this.maxPlayers = 4;
        this.started = false;
        this.turnTimer = null;
        this.turnTimerDuration = 15000;
        this.turnStartTime = null;
        this.rematchVotes = new Set();
        this.gameRules = {
            jumpIn: false,
            shieldCards: false,
            startingHandSize: 7
        };
        this.jumpInWindow = null;
        this.jumpInTimeout = 3000;
    }

    addPlayer(socketId, playerName) {
        if (this.players.length >= this.maxPlayers) return false;
        
        const playerId = `player_${this.players.length}`;
        const player = {
            socketId,
            id: playerId,
            name: playerName || `玩家 ${this.players.length + 1}`,
            isComputer: false,
            ready: false
        };
        
        this.players.push(player);
        playerSockets.set(socketId, { roomId: this.roomId, playerId });
        
        return player;
    }

    removePlayer(socketId) {
        const index = this.players.findIndex(p => p.socketId === socketId);
        if (index !== -1) {
            const player = this.players[index];
            
            this.rematchVotes.delete(player.id);
            
            this.players.splice(index, 1);
            playerSockets.delete(socketId);
            
            if (this.players.length === 0) {
                rooms.delete(this.roomId);
                return true;
            }
        }
        return false;
    }

    updateGameRules(rules) {
        this.gameRules = { ...this.gameRules, ...rules };
        
        this.io.to(this.roomId).emit('roomUpdate', {
            players: this.players,
            canStart: this.canStart(),
            gameRules: this.gameRules
        });
    }

    getPlayerBySocketId(socketId) {
        return this.players.find(p => p.socketId === socketId);
    }

    canStart() {
        return this.players.length >= 1 && this.players.length <= 4 && 
               this.players.every(p => p.ready);
    }

    initializeGame() {
        const allPlayers = [...this.players];
        
        const computerCount = 4 - this.players.length;
        for (let i = 1; i <= computerCount; i++) {
            allPlayers.push({
                id: `computer_${i}`,
                name: `電腦 ${i}`,
                isComputer: true,
                hand: []
            });
        }

        this.gameState = {
            players: allPlayers,
            deck: [],
            discardPile: [],
            currentPlayerIndex: 0,
            currentColorInPlay: '',
            gameDirection: 1,
            isGameOver: false,
            stackPenalty: 0,
            stackType: null,
            isStackActive: false,
            turnStartTime: Date.now(),
            showedUno: [],
            playerHasDrawnThisTurn: false,
            skipNextPlayer: false,
            gameRules: this.gameRules,
            lastPlayTime: Date.now()
        };

        this.createDeck();
        this.shuffleDeck();
        this.dealCards();
        
        let firstCard = this.drawCardFromDeck();
        while (firstCard.type !== 'number') {
            this.gameState.deck.unshift(firstCard);
            this.shuffleDeck();
            firstCard = this.drawCardFromDeck();
        }
        
        this.gameState.discardPile.push(firstCard);
        this.gameState.currentColorInPlay = firstCard.color;
        
        this.started = true;
        this.turnStartTime = Date.now();
        
        return this.gameState;
    }

    createDeck() {
        const colors = ['red', 'yellow', 'green', 'blue'];
        this.gameState.deck = [];
        
        colors.forEach(color => {
            this.gameState.deck.push({ color: color, value: '0', type: 'number', display: '0' });
            for (let i = 0; i < 2; i++) {
                for (let v = 1; v < 10; v++) {
                    this.gameState.deck.push({ color: color, value: String(v), type: 'number', display: String(v) });
                }
                this.gameState.deck.push({ color: color, value: 'skip', type: 'skip', display: '🚫' });
                this.gameState.deck.push({ color: color, value: 'reverse', type: 'reverse', display: '🔄' });
                this.gameState.deck.push({ color: color, value: 'drawTwo', type: 'drawTwo', display: '+2' });
            }
        });
        
        for (let i = 0; i < 4; i++) {
            this.gameState.deck.push({ color: 'black', value: 'wild', type: 'wild', display: 'W' });
            this.gameState.deck.push({ color: 'black', value: 'wildDrawFour', type: 'wildDrawFour', display: 'W+4' });
        }
        
        if (this.gameRules.shieldCards) {
            for (let i = 0; i < 4; i++) {
                this.gameState.deck.push({ color: 'white', value: 'shield', type: 'shield', display: '🛡️' });
            }
        }
    }

    shuffleDeck() {
        const deck = this.gameState.deck;
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
    }

    dealCards() {
        const cardsPerPlayer = this.gameRules.startingHandSize;
        this.gameState.players.forEach(player => {
            player.hand = [];
            for (let i = 0; i < cardsPerPlayer; i++) {
                player.hand.push(this.drawCardFromDeck());
            }
        });
    }

    drawCardFromDeck() {
        if (this.gameState.deck.length === 0) {
            this.refillDeckFromDiscardPile();
        }
        return this.gameState.deck.pop();
    }

    refillDeckFromDiscardPile() {
        if (this.gameState.discardPile.length <= 1) return;
        
        const topCard = this.gameState.discardPile.pop();
        this.gameState.deck = [...this.gameState.discardPile];
        this.gameState.discardPile = [topCard];
        this.shuffleDeck();
    }

    startJumpInWindow() {
        if (!this.gameRules.jumpIn) return;
        
        this.clearJumpInWindow();
        
        this.jumpInWindow = setTimeout(() => {
            this.clearJumpInWindow();
        }, this.jumpInTimeout);
    }

    clearJumpInWindow() {
        if (this.jumpInWindow) {
            clearTimeout(this.jumpInWindow);
            this.jumpInWindow = null;
        }
    }

    canJumpIn(playerId, cardIndex) {
        if (!this.gameRules.jumpIn || !this.jumpInWindow) return false;
        
        const player = this.gameState.players.find(p => p.id === playerId);
        if (!player || cardIndex < 0 || cardIndex >= player.hand.length) return false;
        
        const card = player.hand[cardIndex];
        const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];
        
        return card.color === topCard.color && 
               card.value === topCard.value && 
               card.type === topCard.type;
    }

    makeMove(playerId, move) {
        if (move.type === 'jumpIn') {
            return this.jumpIn(playerId, move.cardIndex);
        }
        
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        
        if (currentPlayer.id !== playerId && !currentPlayer.isComputer) {
            return { success: false, error: '不是你的回合' };
        }

        this.clearTurnTimer();

        switch (move.type) {
            case 'playCard':
                return this.playCard(playerId, move.cardIndex);
            case 'drawCard':
                return this.drawCard(playerId);
            case 'selectColor':
                return this.selectColor(playerId, move.color);
            default:
                return { success: false, error: '無效的操作' };
        }
    }

    jumpIn(playerId, cardIndex) {
        if (!this.canJumpIn(playerId, cardIndex)) {
            return { success: false, error: '無法搶牌' };
        }
        
        this.clearJumpInWindow();
        this.clearTurnTimer();
        
        const player = this.gameState.players.find(p => p.id === playerId);
        const card = player.hand[cardIndex];
        
        player.hand.splice(cardIndex, 1);
        this.gameState.discardPile.push(card);
        
        const playerIndex = this.gameState.players.findIndex(p => p.id === playerId);
        this.gameState.currentPlayerIndex = playerIndex;
        
        let newUnoPlayer = null;
        if (player.hand.length === 1 && !this.gameState.showedUno.includes(player.id)) {
            this.gameState.showedUno.push(player.id);
            newUnoPlayer = player.id;
        }
        
        if (player.hand.length === 0) {
            this.gameState.isGameOver = true;
            this.clearTurnTimer();
            return { success: true, winner: player.name, jumpIn: true };
        }

        if (card.color === 'black') {
            this.gameState.currentColorInPlay = null;
            this.gameState.playerHasDrawnThisTurn = false;
            return { 
                success: true, 
                jumpIn: true,
                needColorSelection: true,
                isWildDrawFour: card.type === 'wildDrawFour',
                newUnoPlayer: newUnoPlayer
            };
        } else {
            this.gameState.currentColorInPlay = card.color;
            this.applyCardEffect(card);
            this.nextTurn();
            
            return { 
                success: true, 
                jumpIn: true,
                newUnoPlayer: newUnoPlayer
            };
        }
    }

    playCard(playerId, cardIndex) {
        const player = this.gameState.players.find(p => p.id === playerId);
        if (!player || cardIndex < 0 || cardIndex >= player.hand.length) {
            return { success: false, error: '無效的卡片' };
        }

        const card = player.hand[cardIndex];
        const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];

        if (!this.isCardPlayable(card, topCard, player.hand.length)) {
            return { success: false, error: '這張牌不能出' };
        }

        this.clearTurnTimer();

        if (card.type === 'shield' && this.gameState.isStackActive) {
            const previousPlayerIndex = this.getPreviousPlayerIndex();
            const previousPlayer = this.gameState.players[previousPlayerIndex];
            
            for (let i = 0; i < this.gameState.stackPenalty; i++) {
                previousPlayer.hand.push(this.drawCardFromDeck());
            }
            
            player.hand.splice(cardIndex, 1);
            this.gameState.discardPile.push(card);
            this.gameState.isStackActive = false;
            this.gameState.stackPenalty = 0;
            this.gameState.stackType = null;
            
            this.nextTurn();
            this.startJumpInWindow();
            
            return { 
                success: true, 
                shieldUsed: true,
                shieldUserId: playerId,
                attackerId: previousPlayer.id
            };
        }

        player.hand.splice(cardIndex, 1);
        this.gameState.discardPile.push(card);
        
        if (card.type !== 'shield') {
            this.gameState.currentColorInPlay = card.color === 'black' ? null : card.color;
        }

        let newUnoPlayer = null;
        if (player.hand.length === 1 && !this.gameState.showedUno.includes(player.id)) {
            this.gameState.showedUno.push(player.id);
            newUnoPlayer = player.id;
        }

        if (card.color === 'black') {
            return { 
                success: true, 
                needColorSelection: true,
                isWildDrawFour: card.type === 'wildDrawFour',
                newUnoPlayer: newUnoPlayer
            };
        }

        this.applyCardEffect(card);
        
        let skippedPlayerId = null;
        if (card.type === 'skip' || (card.type === 'reverse' && this.gameState.players.length === 2)) {
            const nextIndex = this.getNextPlayerIndex();
            skippedPlayerId = this.gameState.players[nextIndex].id;
        }
        
        if (player.hand.length === 0) {
            this.gameState.isGameOver = true;
            this.clearTurnTimer();
            return { success: true, winner: player.name };
        }

        this.nextTurn();
        this.startJumpInWindow();

        return { 
            success: true, 
            newUnoPlayer: newUnoPlayer,
            skippedPlayerId: skippedPlayerId
        };
    }

    drawCard(playerId) {
        const player = this.gameState.players.find(p => p.id === playerId);
        if (!player) return { success: false, error: '玩家不存在' };

        if (this.gameState.playerHasDrawnThisTurn && !this.gameState.isStackActive) {
            return { success: false, error: '本回合已經抽過牌' };
        }

        if (this.gameState.isStackActive && 
            this.gameRules.shieldCards && 
            player.hand.some(card => card.type === 'shield')) {
            return { success: false, error: '你有神盾牌可以使用' };
        }

        if (this.gameState.isStackActive) {
            for (let i = 0; i < this.gameState.stackPenalty; i++) {
                player.hand.push(this.drawCardFromDeck());
            }
            this.gameState.isStackActive = false;
            this.gameState.stackPenalty = 0;
            this.gameState.stackType = null;
            this.gameState.playerHasDrawnThisTurn = true;
            this.nextTurn();
            return { success: true, drewPenalty: true };
        }

        const drawnCard = this.drawCardFromDeck();
        player.hand.push(drawnCard);
        this.gameState.playerHasDrawnThisTurn = true;

        const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];
        const canPlay = this.isCardPlayable(drawnCard, topCard, player.hand.length);

        if (canPlay) {
            const elapsedTime = Date.now() - this.turnStartTime;
            const remainingTime = Math.max(0, this.turnTimerDuration - elapsedTime);
            
            this.clearTurnTimer();
            if (remainingTime > 0) {
                this.turnTimer = setTimeout(() => {
                    if (!this.gameState.isGameOver) {
                        this.handleTurnTimeout();
                    }
                }, remainingTime);
            } else {
                this.handleTurnTimeout();
                return { success: true, timeout: true };
            }
            
            return { 
                success: true, 
                drawnCard: drawnCard,
                canPlayDrawnCard: true,
                remainingTime: Math.ceil(remainingTime / 1000)
            };
        } else {
            this.nextTurn();
            return { 
                success: true, 
                drawnCard: drawnCard,
                canPlayDrawnCard: false,
                autoEndTurn: true
            };
        }
    }

    selectColor(playerId, color) {
        const validColors = ['red', 'yellow', 'green', 'blue'];
        if (!validColors.includes(color)) {
            return { success: false, error: '無效的顏色' };
        }

        this.clearTurnTimer();
        this.gameState.currentColorInPlay = color;
        
        const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];
        this.applyCardEffect(topCard);
        
        let skippedPlayerId = null;
        if (topCard.type === 'wildDrawFour' && this.gameState.isStackActive) {
            const nextIndex = this.getNextPlayerIndex();
            skippedPlayerId = this.gameState.players[nextIndex].id;
        }
        
        this.nextTurn();
        this.startJumpInWindow();

        return { success: true, skippedPlayerId: skippedPlayerId };
    }

    isCardPlayable(card, topCard, handSize) {
        if (!topCard) return true;
        
        if (handSize === 1 && (card.type === 'drawTwo' || card.type === 'wildDrawFour' || card.type === 'skip' || card.type === 'reverse')) {
            return false;
        }
        
        if (this.gameState.isStackActive) {
            if (this.gameState.stackType === 'drawTwo' && card.type === 'drawTwo') return true;
            if (this.gameState.stackType === 'wildDrawFour' && card.type === 'wildDrawFour') return true;
            if (this.gameRules.shieldCards && card.type === 'shield') return true;
            return false;
        }
        
        if (card.color === 'black' || card.type === 'shield') return true;
        
        const effectiveColor = this.gameState.currentColorInPlay || topCard.color;
        
        return card.color === effectiveColor || card.value === topCard.value;
    }

    applyCardEffect(card) {
        switch (card.type) {
            case 'skip':
                this.gameState.skipNextPlayer = true;
                break;
                
            case 'reverse':
                if (this.gameState.players.length > 2) {
                    this.gameState.gameDirection *= -1;
                } else {
                    this.gameState.skipNextPlayer = true;
                }
                break;
                
            case 'drawTwo':
                if (this.gameState.isStackActive && this.gameState.stackType === 'drawTwo') {
                    this.gameState.stackPenalty += 2;
                } else {
                    this.gameState.isStackActive = true;
                    this.gameState.stackType = 'drawTwo';
                    this.gameState.stackPenalty = 2;
                }
                break;
                
            case 'wildDrawFour':
                if (this.gameState.isStackActive && this.gameState.stackType === 'wildDrawFour') {
                    this.gameState.stackPenalty += 4;
                } else {
                    this.gameState.isStackActive = true;
                    this.gameState.stackType = 'wildDrawFour';
                    this.gameState.stackPenalty = 4;
                }
                break;
        }
    }

    getNextPlayerIndex() {
        let nextIndex = this.gameState.currentPlayerIndex + this.gameState.gameDirection;
        if (nextIndex >= this.gameState.players.length) nextIndex = 0;
        if (nextIndex < 0) nextIndex = this.gameState.players.length - 1;
        return nextIndex;
    }

    getPreviousPlayerIndex() {
        let prevIndex = this.gameState.currentPlayerIndex - this.gameState.gameDirection;
        if (prevIndex >= this.gameState.players.length) prevIndex = 0;
        if (prevIndex < 0) prevIndex = this.gameState.players.length - 1;
        return prevIndex;
    }

    nextTurn() {
        this.gameState.showedUno = this.gameState.showedUno.filter(playerId => {
            const player = this.gameState.players.find(p => p.id === playerId);
            return player && player.hand.length === 1;
        });

        this.gameState.currentPlayerIndex = this.getNextPlayerIndex();
        
        if (this.gameState.skipNextPlayer) {
            this.gameState.currentPlayerIndex = this.getNextPlayerIndex();
            this.gameState.skipNextPlayer = false;
        }
        
        this.gameState.turnStartTime = Date.now();
        this.gameState.playerHasDrawnThisTurn = false;
        this.turnStartTime = Date.now();
        
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        if (currentPlayer.isComputer) {
            const computerThinkTime = Math.random() * 2000 + 2000;
            setTimeout(() => {
                if (!this.gameState.isGameOver) {
                    this.computerTurn();
                }
            }, computerThinkTime);
        } else {
            this.startTurnTimer();
        }
    }

    startTurnTimer() {
        this.clearTurnTimer();
        
        this.turnTimer = setTimeout(() => {
            if (this.gameState.isGameOver) return;
            
            this.handleTurnTimeout();
        }, this.turnTimerDuration);
    }

    handleTurnTimeout() {
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const currentPlayerId = currentPlayer.id;
        
        if (!this.gameState.playerHasDrawnThisTurn) {
            const player = this.gameState.players.find(p => p.id === currentPlayerId);
            
            if (this.gameState.isStackActive) {
                for (let i = 0; i < this.gameState.stackPenalty; i++) {
                    player.hand.push(this.drawCardFromDeck());
                }
                this.gameState.isStackActive = false;
                this.gameState.stackPenalty = 0;
                this.gameState.stackType = null;
            } else {
                player.hand.push(this.drawCardFromDeck());
            }
        }
        
        this.nextTurn();
        
        this.players.forEach(player => {
            if (!player.isComputer && player.socketId) {
                const playerGameState = this.getGameStateForPlayer(player.id);
                this.io.to(player.socketId).emit('gameUpdate', {
                    gameState: playerGameState,
                    lastMove: { type: 'timeout', playerId: currentPlayerId },
                    result: { timeout: true, forceEndTurn: true }
                });
            }
        });
    }

    clearTurnTimer() {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.turnTimer = null;
        }
    }

    computerTurn() {
        const computer = this.gameState.players[this.gameState.currentPlayerIndex];
        if (!computer.isComputer || this.gameState.isGameOver) return;

        const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];
        
        if (this.gameState.isStackActive && this.gameRules.shieldCards) {
            const shieldIndex = computer.hand.findIndex(card => card.type === 'shield');
            if (shieldIndex !== -1 && Math.random() < 0.7) {
                const result = this.playCard(computer.id, shieldIndex);
                const move = { type: 'playCard', cardIndex: shieldIndex, playerId: computer.id };
                
                this.broadcastGameUpdate(move, result);
                return;
            }
        }
        
        let playableCardIndex = -1;
        for (let i = 0; i < computer.hand.length; i++) {
            if (this.isCardPlayable(computer.hand[i], topCard, computer.hand.length)) {
                playableCardIndex = i;
                break;
            }
        }

        let result;
        let move;

        if (playableCardIndex !== -1) {
            result = this.playCard(computer.id, playableCardIndex);
            move = { type: 'playCard', cardIndex: playableCardIndex, playerId: computer.id };
            
            if (result.needColorSelection) {
                const colors = ['red', 'yellow', 'green', 'blue'];
                const colorCounts = { red: 0, yellow: 0, green: 0, blue: 0 };
                
                computer.hand.forEach(card => {
                    if (card.color !== 'black' && card.color !== 'white') colorCounts[card.color]++;
                });
                
                let bestColor = colors[0];
                let maxCount = -1;
                for (const color of colors) {
                    if (colorCounts[color] > maxCount) {
                        maxCount = colorCounts[color];
                        bestColor = color;
                    }
                }
                
                const colorResult = this.selectColor(computer.id, bestColor);
                result = { ...colorResult, newUnoPlayer: result.newUnoPlayer, skippedPlayerId: result.skippedPlayerId };
            }
        } else {
            result = this.drawCard(computer.id);
            move = { type: 'drawCard', playerId: computer.id };
            
            if (!result.drewPenalty && result.canPlayDrawnCard) {
                const playResult = this.playCard(computer.id, computer.hand.length - 1);
                move = { type: 'playCard', cardIndex: computer.hand.length, playerId: computer.id };
                result = playResult;
                
                if (playResult.needColorSelection) {
                    const colors = ['red', 'yellow', 'green', 'blue'];
                    const colorCounts = { red: 0, yellow: 0, green: 0, blue: 0 };
                    
                    computer.hand.forEach(card => {
                        if (card.color !== 'black' && card.color !== 'white') colorCounts[card.color]++;
                    });
                    
                    let bestColor = colors[0];
                    let maxCount = -1;
                    for (const color of colors) {
                        if (colorCounts[color] > maxCount) {
                            maxCount = colorCounts[color];
                            bestColor = color;
                        }
                    }
                    
                    const colorResult = this.selectColor(computer.id, bestColor);
                    result = { ...colorResult, newUnoPlayer: playResult.newUnoPlayer, skippedPlayerId: playResult.skippedPlayerId };
                }
            }
        }

        this.broadcastGameUpdate(move, result);

        if (result && result.winner) {
            this.clearTurnTimer();
            this.io.to(this.roomId).emit('gameOver', { winner: result.winner });
        }
    }

    broadcastGameUpdate(move, result) {
        this.players.forEach(player => {
            if (!player.isComputer && player.socketId) {
                const playerGameState = this.getGameStateForPlayer(player.id);
                this.io.to(player.socketId).emit('gameUpdate', {
                    gameState: playerGameState,
                    lastMove: move,
                    result: result
                });
            }
        });
    }

    requestRematch(playerId) {
        if (!this.gameState || !this.gameState.isGameOver) {
            return { success: false, error: '遊戲尚未結束' };
        }

        const player = this.players.find(p => p.id === playerId);
        if (!player) {
            return { success: false, error: '玩家不存在' };
        }

        this.rematchVotes.add(playerId);

        const humanPlayers = this.players.filter(p => !p.isComputer);
        const allVoted = humanPlayers.every(p => this.rematchVotes.has(p.id));

        this.io.to(this.roomId).emit('rematchUpdate', {
            votes: Array.from(this.rematchVotes),
            totalPlayers: humanPlayers.length,
            allVoted: allVoted
        });

        if (allVoted) {
            this.resetForRematch();
            return { success: true, startingNewGame: true };
        }

        return { success: true };
    }

    resetForRematch() {
        this.rematchVotes.clear();
        this.players = this.players.filter(p => !p.isComputer);
        
        this.players.forEach(player => {
            player.ready = false;
        });
        
        this.gameState = null;
        this.started = false;
        this.clearTurnTimer();
        this.clearJumpInWindow();
        
        this.io.to(this.roomId).emit('returnToWaitingRoom', {
            players: this.players
        });
    }

    getGameStateForPlayer(playerId) {
        if (!this.gameState) return null;
        const sanitizedPlayers = this.gameState.players.map(player => {
            if (player.id === playerId) {
                return { ...player, hand: player.hand };
            } else {
                return { 
                    ...player, 
                    hand: player.hand.map(() => ({})),
                    handCount: player.hand.length 
                };
            }
        });

        return {
            ...this.gameState,
            players: sanitizedPlayers,
            deckCount: this.gameState.deck.length,
            playerHasDrawnThisTurn: this.gameState.playerHasDrawnThisTurn,
            skipNextPlayer: this.gameState.skipNextPlayer
        };
    }
}

io.on('connection', (socket) => {
    console.log('新玩家連接:', socket.id);

    socket.on('createRoom', (playerName) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const room = new GameRoom(roomId, io);
        rooms.set(roomId, room);
        
        const player = room.addPlayer(socket.id, playerName);
        socket.join(roomId);
        
        socket.emit('roomCreated', { roomId, player });
        io.to(roomId).emit('roomUpdate', {
            players: room.players,
            canStart: room.canStart(),
            gameRules: room.gameRules
        });
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms.get(roomId);
        
        if (!room) {
            socket.emit('joinError', '房間不存在');
            return;
        }
        
        if (room.started) {
            socket.emit('joinError', '遊戲已經開始');
            return;
        }
        
        if (room.players.length >= room.maxPlayers) {
            socket.emit('joinError', '房間已滿');
            return;
        }
        
        const player = room.addPlayer(socket.id, playerName);
        socket.join(roomId);
        
        socket.emit('joinSuccess', { roomId, player, gameRules: room.gameRules });
        io.to(roomId).emit('roomUpdate', {
            players: room.players,
            canStart: room.canStart(),
            gameRules: room.gameRules
        });
    });

    socket.on('updateGameRules', (rules) => {
        const playerInfo = playerSockets.get(socket.id);
        if (!playerInfo) return;
        
        const room = rooms.get(playerInfo.roomId);
        if (!room || room.started) return;
        
        const player = room.getPlayerBySocketId(socket.id);
        if (player && room.players[0].id === player.id) {
            room.updateGameRules(rules);
        }
    });

    socket.on('playerReady', () => {
        const playerInfo = playerSockets.get(socket.id);
        if (!playerInfo) return;
        
        const room = rooms.get(playerInfo.roomId);
        if (!room) return;
        
        const player = room.getPlayerBySocketId(socket.id);
        if (player) {
            player.ready = true;
            io.to(playerInfo.roomId).emit('roomUpdate', {
                players: room.players,
                canStart: room.canStart(),
                gameRules: room.gameRules
            });
            
            if (room.canStart()) {
                const gameState = room.initializeGame();
                
                room.players.forEach(p => {
                    if (!p.isComputer) {
                        const playerGameState = room.getGameStateForPlayer(p.id);
                        io.to(p.socketId).emit('gameStart', {
                            playerId: p.id,
                            gameState: playerGameState
                        });
                    }
                });
                
                if (gameState.players[0].isComputer) {
                    const computerThinkTime = Math.random() * 2000 + 2000;
                    setTimeout(() => {
                        if (room.started && !room.gameState.isGameOver) {
                            room.computerTurn();
                        }
                    }, computerThinkTime);
                } else {
                    room.startTurnTimer();
                }
            }
        }
    });

    socket.on('gameMove', (move) => {
        const playerInfo = playerSockets.get(socket.id);
        if (!playerInfo) return;
        
        const room = rooms.get(playerInfo.roomId);
        if (!room || !room.started) return;
        
        const result = room.makeMove(playerInfo.playerId, move);
        
        if (result.success) {
            room.players.forEach(player => {
                if (!player.isComputer) {
                    const playerGameState = room.getGameStateForPlayer(player.id);
                    io.to(player.socketId).emit('gameUpdate', {
                        gameState: playerGameState,
                        lastMove: { ...move, playerId: playerInfo.playerId },
                        result: result
                    });
                }
            });
            
            if (result.winner) {
                io.to(playerInfo.roomId).emit('gameOver', {
                    winner: result.winner
                });
            }
        } else {
            socket.emit('moveError', result.error);
        }
    });

    socket.on('requestRematch', () => {
        const playerInfo = playerSockets.get(socket.id);
        if (!playerInfo) return;
        
        const room = rooms.get(playerInfo.roomId);
        if (!room) return;
        
        room.requestRematch(playerInfo.playerId);
    });

    socket.on('disconnect', () => {
        console.log('玩家斷線:', socket.id);
        
        const playerInfo = playerSockets.get(socket.id);
        if (playerInfo) {
            const room = rooms.get(playerInfo.roomId);
            if (room) {
                if (room.gameState && room.gameState.isGameOver && room.rematchVotes.has(playerInfo.playerId)) {
                    room.rematchVotes.delete(playerInfo.playerId);
                    const humanPlayers = room.players.filter(p => !p.isComputer);
                    io.to(playerInfo.roomId).emit('rematchUpdate', {
                        votes: Array.from(room.rematchVotes),
                        totalPlayers: humanPlayers.length - 1,
                        allVoted: false
                    });
                }
                
                const roomDeleted = room.removePlayer(socket.id);
                
                if (!roomDeleted) {
                    io.to(playerInfo.roomId).emit('roomUpdate', {
                       players: room.players,
                       canStart: room.canStart(),
                       gameRules: room.gameRules
                    });

                    if (room.started && (!room.gameState || !room.gameState.isGameOver)) {
                        room.clearTurnTimer();
                        io.to(playerInfo.roomId).emit('gameOver', {
                            winner: null,
                            reason: `${playerInfo.playerName || 'A player'} has left the game.`
                        });
                        room.resetForRematch();
                    }
                }
            }
        }
    });
});

server.listen(PORT, HOST, () => {
    console.log(`多人UNO遊戲服務器正在運行於 http://${HOST}:${PORT}`);
    console.log(`本地訪問: http://localhost:${PORT}`);
    console.log(`按 Ctrl+C 停止服務器`);
});
