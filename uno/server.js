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

// Animation/Effect durations (in ms)
const ANIMATION_DURATIONS = {
    SHARE_PAIN_BIND: 2600,
    SHARE_PAIN_TRIGGER: 3100,
    DRAW_CARD: 500,
    DRAW_CARD_DELAY: 150, // 前端每張抽牌動畫之間的延遲
    SKIP: 1300,
    REVERSE: 1300,
    TIMEOUT: 1900,
    SHIELD: 2800, // 前端盾牌動畫實際需要2800ms
    BASIC_CARD: 800, // 增加基本卡片動畫時間，確保前端600ms動畫有足夠緩衝
    JUMP_IN: 1300, // Jump-in動畫時間，匹配前端1300ms動畫
    
    // 電腦玩家專用的較短動畫時間，保持流暢度
    COMPUTER: {
        SHARE_PAIN_BIND: 1500,
        SHARE_PAIN_TRIGGER: 2000,
        DRAW_CARD: 400,
        SKIP: 800,
        REVERSE: 800,
        TIMEOUT: 1200,
        SHIELD: 2000, // 電腦也需要等待盾牌動畫
        BASIC_CARD: 700, // 電腦也需要等待前端動畫完成
        JUMP_IN: 1100 // 電腦Jump-in動畫時間，略短於人類玩家但足夠播放
    }
};

// 計算抽牌動畫時間的輔助函數
function calculateDrawAnimationTime(cardCount, isComputer = false) {
    const durations = isComputer ? ANIMATION_DURATIONS.COMPUTER : ANIMATION_DURATIONS;
    const baseTime = cardCount * (durations.DRAW_CARD + ANIMATION_DURATIONS.DRAW_CARD_DELAY);
    
    // 為大量抽牌添加額外緩衝時間
    let bufferTime = 0;
    if (cardCount >= 8) {
        bufferTime = 1000; // 8張或以上額外1秒
    } else if (cardCount >= 4) {
        bufferTime = 500;  // 4-7張額外0.5秒
    } else if (cardCount >= 2) {
        bufferTime = 200;  // 2-3張額外0.2秒
    }
    
    return baseTime + bufferTime;
}

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
            sharePain: false,
            startingHandSize: 7
        };
        this.computerThinkTimer = null;
        this.actionInProgress = false;
        
        // Jump-In properties
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
            lastPlayTime: Date.now(),
            sharePainBindings: {},
            waitingForColorSelection: false,
            isActionPaused: false 
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

        if (this.gameRules.sharePain) {
            for (let i = 0; i < 2; i++) {
                this.gameState.deck.push({ color: 'white', value: 'sharePain', type: 'sharePain', display: '🔗' });
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
        if (!this.gameRules || !this.gameRules.jumpIn) return;
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
        if (!this.gameRules.jumpIn || this.gameState.isActionPaused || !this.jumpInWindow) return false;
        const player = this.gameState.players.find(p => p.id === playerId);
        if (!player || cardIndex < 0 || cardIndex >= player.hand.length) return false;
        const card = player.hand[cardIndex];
        const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];
        if (!topCard) return false;
        return card.color === topCard.color && 
               card.value === topCard.value && 
               card.type === topCard.type;
    }
    
    pauseAndResume(duration, move, result, playerId = null) {
        if (this.actionInProgress) return;

        this.actionInProgress = true;
        this.clearTurnTimer();
        this.clearComputerThinkTimer();
        this.clearJumpInWindow();
        
        this.gameState.isActionPaused = true;
        this.broadcastGameUpdate(move, result);

        // 使用與動畫類型匹配的持續時間，確保前端動畫完成
        let actualDuration = duration;
        
        // 對於電腦玩家，使用預設的電腦專用時間，不再進一步縮減
        if (playerId) {
            const player = this.gameState.players.find(p => p.id === playerId);
            if (player && player.isComputer) {
                // 電腦玩家已經有專用的較短動畫時間，不需要額外縮減
                actualDuration = duration;
            }
        }

        setTimeout(() => {
            // 檢查遊戲狀態是否仍然存在（避免遊戲結束後的回調執行）
            if (!this.gameState) {
                this.actionInProgress = false;
                return;
            }
            
            this.gameState.isActionPaused = false;
            
            // 如果在等待選色，不要進入下一回合
            if (!this.gameState.waitingForColorSelection) {
                this.nextTurn();
                
                // 延遲開啟Jump-in窗口，確保動畫完成後才能搶牌
                setTimeout(() => {
                    if (this.gameState) { // 再次檢查狀態
                        this.startJumpInWindow();
                    }
                }, 200);
            }
            
            this.broadcastGameUpdate({}, {});
            this.actionInProgress = false;
        }, actualDuration);
    }

    makeMove(playerId, move) {
        const player = this.gameState.players.find(p => p.id === playerId);
        const isComputerPlayer = player && player.isComputer;
        
        // 改進的動畫狀態檢查：只對人類玩家在非Jump-in情況下檢查
        if (!isComputerPlayer && this.actionInProgress && move.type !== 'jumpIn') {
            return { success: false, error: '正在處理動畫，請稍候' };
        }

        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        
        if (move.type !== 'selectColor' && currentPlayer.id !== playerId) {
             if (move.type === 'jumpIn' && this.canJumpIn(playerId, move.cardIndex)) {
                // Allow jump-in
             } else {
                return { success: false, error: '不是你的回合' };
             }
        }
        
        this.clearTurnTimer();
        this.clearComputerThinkTimer();

        switch (move.type) {
            case 'playCard':
                return this.playCard(playerId, move.cardIndex);
            case 'drawCard':
                return this.drawCard(playerId);
            case 'selectColor':
                return this.selectColor(playerId, move.color);
            case 'jumpIn':
                return this.jumpIn(playerId, move.cardIndex);
            case 'playSharePainCard':
                return this.playSharePainCard(playerId, move.cardIndex, move.targetPlayerId);
            default:
                return { success: false, error: '無效的操作' };
        }
    }

    playSharePainCard(playerId, cardIndex, targetPlayerId) {
        const player = this.gameState.players.find(p => p.id === playerId);
        const targetPlayer = this.gameState.players.find(p => p.id === targetPlayerId);
        
        if (!player || !targetPlayer) {
            return { success: false, error: '玩家不存在' };
        }

        if (cardIndex < 0 || cardIndex >= player.hand.length) {
            return { success: false, error: '無效的卡片' };
        }

        const card = player.hand[cardIndex];
        if (card.type !== 'sharePain') {
            return { success: false, error: '不是同甘共苦牌' };
        }

        const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];
        if (!this.isCardPlayable(card, topCard, player.hand.length)) {
            return { success: false, error: '這張牌不能出' };
        }
        
        player.hand.splice(cardIndex, 1);
        this.gameState.discardPile.push(card);

        this.gameState.sharePainBindings = {};
        
        this.gameState.sharePainBindings[playerId] = {
            user: playerId,
            target: targetPlayerId
        };

        let newUnoPlayer = null;
        if (player.hand.length === 1 && !this.gameState.showedUno.includes(player.id)) {
            this.gameState.showedUno.push(player.id);
            newUnoPlayer = player.id;
        }

        if (player.hand.length === 0) {
            this.gameState.isGameOver = true;
            return { success: true, winner: player.name };
        }
        
        const result = { 
            success: true, 
            sharePainUsed: true,
            userId: playerId,
            targetId: targetPlayerId,
            newUnoPlayer: newUnoPlayer
        };
        const move = { type: 'playSharePainCard', cardIndex, playerId, targetPlayerId };

        // 統一使用動畫系統，確保所有玩家操作的一致性
        const isComputer = this.gameState.players.find(p => p.id === playerId)?.isComputer;
        const durations = isComputer ? ANIMATION_DURATIONS.COMPUTER : ANIMATION_DURATIONS;
        this.pauseAndResume(durations.SHARE_PAIN_BIND, move, result, playerId);
        return { success: true, needsServerContinuation: true };
    }

    jumpIn(playerId, cardIndex) {
        if (!this.canJumpIn(playerId, cardIndex)) {
            return { success: false, error: '無法搶牌' };
        }
        
        this.clearJumpInWindow();
        
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
            return { success: true, winner: player.name, jumpIn: true };
        }

        if (card.color === 'black') {
            this.gameState.waitingForColorSelection = true; 
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
            
            const result = { 
                success: true, 
                jumpIn: true,
                newUnoPlayer: newUnoPlayer
            };
            const move = { type: 'jumpIn', cardIndex, playerId };
            
            // 為Jump-in也使用動畫系統
            const isComputer = this.gameState.players.find(p => p.id === playerId)?.isComputer;
            const durations = isComputer ? ANIMATION_DURATIONS.COMPUTER : ANIMATION_DURATIONS;
            this.pauseAndResume(durations.JUMP_IN, move, result, playerId);
            return { success: true, needsServerContinuation: true };
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
        
        if (card.type === 'shield' && this.gameState.isStackActive) {
            const previousPlayerIndex = this.getPreviousPlayerIndex();
            const previousPlayer = this.gameState.players[previousPlayerIndex];
            
            const penaltyResult = this.applyPenaltyCards(previousPlayer.id, this.gameState.stackPenalty, 'shield');
            
            player.hand.splice(cardIndex, 1);
            this.gameState.discardPile.push(card);
            this.gameState.isStackActive = false;
            this.gameState.stackPenalty = 0;
            this.gameState.stackType = null;
            
            const result = { 
                success: true, 
                shieldUsed: true,
                shieldUserId: playerId,
                attackerId: previousPlayer.id,
                ...penaltyResult
            };
            const move = {type: 'playCard', cardIndex, playerId};
            const isComputer = player && player.isComputer;
            const durations = isComputer ? ANIMATION_DURATIONS.COMPUTER : ANIMATION_DURATIONS;
            const drawAnimationTime = calculateDrawAnimationTime(penaltyResult.drawnCards.length, isComputer);
            
            // 如果觸發了同甘共苦，需要額外的動畫時間
            let totalDuration = durations.SHIELD + drawAnimationTime;
            if (penaltyResult.sharePainTriggered) {
                totalDuration += durations.SHARE_PAIN_TRIGGER;
            }
            this.pauseAndResume(totalDuration, move, result, playerId);
            return { success: true, needsServerContinuation: true };
        }

        player.hand.splice(cardIndex, 1);
        this.gameState.discardPile.push(card);
        
        if (card.type !== 'shield' && card.type !== 'sharePain') {
            this.gameState.currentColorInPlay = card.color === 'black' ? null : card.color;
        }

        let newUnoPlayer = null;
        if (player.hand.length === 1 && !this.gameState.showedUno.includes(player.id)) {
            this.gameState.showedUno.push(player.id);
            newUnoPlayer = player.id;
        }

        if (card.color === 'black') {
            this.gameState.waitingForColorSelection = true;
            
            const result = { 
                success: true, 
                needColorSelection: true,
                isWildDrawFour: card.type === 'wildDrawFour',
                newUnoPlayer: newUnoPlayer
            };
            const move = {type: 'playCard', cardIndex, playerId};

            // 即使是需要選色的卡片，也要先執行動畫
            const isComputer = player && player.isComputer;
            const durations = isComputer ? ANIMATION_DURATIONS.COMPUTER : ANIMATION_DURATIONS;
            const animationDuration = durations.BASIC_CARD;
            
            this.pauseAndResume(animationDuration, move, result, playerId);
            return { success: true, needsServerContinuation: true, needColorSelection: true };
        }

        this.applyCardEffect(card);
        
        let skippedPlayerId = null;
        if (card.type === 'skip' || (card.type === 'reverse' && this.gameState.players.length === 2)) {
            const nextIndex = this.getNextPlayerIndex();
            skippedPlayerId = this.gameState.players[nextIndex].id;
        }
        
        if (player.hand.length === 0) {
            this.gameState.isGameOver = true;
            return { success: true, winner: player.name };
        }

        const result = { 
            success: true, 
            newUnoPlayer: newUnoPlayer,
            skippedPlayerId: skippedPlayerId
        };
        const move = {type: 'playCard', cardIndex, playerId};

        // 統一使用動畫系統，確保所有玩家操作的一致性
        const isComputer = player && player.isComputer;
        const durations = isComputer ? ANIMATION_DURATIONS.COMPUTER : ANIMATION_DURATIONS;
        
        let animationDuration;
        if (card.type === 'skip' || (card.type === 'reverse' && this.gameState.players.length === 2)) {
            animationDuration = durations.SKIP;
        } else {
            animationDuration = durations.BASIC_CARD;
        }
        
        this.pauseAndResume(animationDuration, move, result, playerId);
        return { success: true, needsServerContinuation: true };
    }

    drawCard(playerId) {
        const player = this.gameState.players.find(p => p.id === playerId);
        if (!player) return { success: false, error: '玩家不存在' };

        if (this.gameState.playerHasDrawnThisTurn && !this.gameState.isStackActive) {
            return { success: false, error: '本回合已經抽過牌' };
        }
        
        if (this.gameState.isStackActive) {
            const penaltyResult = this.applyPenaltyCards(playerId, this.gameState.stackPenalty, 'stack');
            
            this.gameState.isStackActive = false;
            this.gameState.stackPenalty = 0;
            this.gameState.stackType = null;
            this.gameState.playerHasDrawnThisTurn = true;
            
            const result = { 
                success: true, 
                drewPenalty: true,
                ...penaltyResult
            };
            const move = {type: 'drawCard', playerId};

            // 統一使用動畫系統處理懲罰抽牌
            const isComputer = player && player.isComputer;
            const durations = isComputer ? ANIMATION_DURATIONS.COMPUTER : ANIMATION_DURATIONS;
            
            let baseDuration = 500;
            const drawAnimationTime = calculateDrawAnimationTime(penaltyResult.drawnCards.length, isComputer);
            let totalDuration = baseDuration + drawAnimationTime;
            
            // 如果觸發了同甘共苦，需要額外的動畫時間
            if (penaltyResult.sharePainTriggered) {
                totalDuration += durations.SHARE_PAIN_TRIGGER;
            }

            this.pauseAndResume(totalDuration, move, result, playerId);
            return { success: true, needsServerContinuation: true };
        }

        const drawnCard = this.drawCardFromDeck();
        player.hand.push(drawnCard);
        this.gameState.playerHasDrawnThisTurn = true;

        const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];
        const canPlay = this.isCardPlayable(drawnCard, topCard, player.hand.length);

        if (canPlay) {
            const elapsedTime = Date.now() - this.turnStartTime;
            const remainingTime = Math.max(0, this.turnTimerDuration - elapsedTime);
            
            if (remainingTime > 0) {
                this.turnTimer = setTimeout(() => {
                    if (this.gameState && !this.gameState.isGameOver) {
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
                drawnCards: [{ card: drawnCard, targetId: playerId }],
                canPlayDrawnCard: true,
                remainingTime: Math.floor(remainingTime / 1000)
            };
        } else {
             const result = { 
                success: true, 
                drawnCard: drawnCard,
                drawnCards: [{ card: drawnCard, targetId: playerId }],
                canPlayDrawnCard: false,
                autoEndTurn: true
            };
            const move = {type: 'drawCard', playerId};

            // 統一使用動畫系統處理普通抽牌
            const isComputer = player && player.isComputer;
            const durations = isComputer ? ANIMATION_DURATIONS.COMPUTER : ANIMATION_DURATIONS;
            this.pauseAndResume(durations.DRAW_CARD, move, result, playerId);
            return { success: true, needsServerContinuation: true };
        }
    }

    applyPenaltyCards(targetPlayerId, penaltyCount, reason = 'normal') {
        const targetPlayer = this.gameState.players.find(p => p.id === targetPlayerId);
        if (!targetPlayer) return { sharePainTriggered: false };

        let sharePainTriggered = false;
        let affectedPlayers = [targetPlayerId];
        let triggerPlayer = targetPlayerId;
        let partnerPlayer = null;
        let drawnCards = [];

        // Share Pain only triggers on attacks ('stack' or 'shield'), not personal penalties like 'timeout'
        if (this.gameRules.sharePain && (reason === 'stack' || reason === 'shield')) {
            let binding = null;
            
            if (this.gameState.sharePainBindings[targetPlayerId]) {
                binding = this.gameState.sharePainBindings[targetPlayerId];
                partnerPlayer = this.gameState.players.find(p => p.id === binding.target);
            } else {
                for (const [userId, userBinding] of Object.entries(this.gameState.sharePainBindings)) {
                    if (userBinding.target === targetPlayerId) {
                        binding = userBinding;
                        partnerPlayer = this.gameState.players.find(p => p.id === userId);
                        break;
                    }
                }
            }
            
            if (partnerPlayer && binding) {
                for (let i = 0; i < penaltyCount; i++) {
                    const card1 = this.drawCardFromDeck();
                    const card2 = this.drawCardFromDeck();
                    targetPlayer.hand.push(card1);
                    partnerPlayer.hand.push(card2);
                    drawnCards.push(
                        { card: card1, targetId: targetPlayerId },
                        { card: card2, targetId: partnerPlayer.id }
                    );
                }
                
                sharePainTriggered = true;
                affectedPlayers = [targetPlayerId, partnerPlayer.id];
                triggerPlayer = targetPlayerId;
            } else {
                for (let i = 0; i < penaltyCount; i++) {
                    const card = this.drawCardFromDeck();
                    targetPlayer.hand.push(card);
                    drawnCards.push({ card: card, targetId: targetPlayerId });
                }
            }
        } else {
            for (let i = 0; i < penaltyCount; i++) {
                const card = this.drawCardFromDeck();
                targetPlayer.hand.push(card);
                drawnCards.push({ card: card, targetId: targetPlayerId });
            }
        }

        return {
            sharePainTriggered,
            triggerPlayer,
            affectedPlayers,
            penaltyCount,
            drawnCards
        };
    }

    selectColor(playerId, color) {
        const validColors = ['red', 'yellow', 'green', 'blue'];
        if (!validColors.includes(color)) {
            return { success: false, error: '無效的顏色' };
        }
        
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        if (playerId !== currentPlayer.id) {
            return { success: false, error: '不是你的回合來選擇顏色' };
        }

        this.gameState.waitingForColorSelection = false; 
        this.gameState.currentColorInPlay = color;
        
        const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];
        this.applyCardEffect(topCard);
        
        const result = { success: true };
        const move = { type: 'selectColor', color, playerId };
        
        // 統一使用動畫系統處理顏色選擇
        const isComputer = this.gameState.players.find(p => p.id === playerId)?.isComputer;
        const durations = isComputer ? ANIMATION_DURATIONS.COMPUTER : ANIMATION_DURATIONS;
        this.pauseAndResume(durations.BASIC_CARD, move, result, playerId);
        return { success: true, needsServerContinuation: true };
    }

    isCardPlayable(card, topCard, handSize) {
        if (!topCard) return true;
        
        if (this.gameState.isActionPaused || this.gameState.waitingForColorSelection) return false;

        if (handSize === 1 && (card.type === 'drawTwo' || card.type === 'wildDrawFour' || 
            card.type === 'skip' || card.type === 'reverse' || card.type === 'shield' || 
            card.type === 'sharePain')) {
            return false;
        }
        
        if (this.gameState.isStackActive) {
            if (this.gameState.stackType === 'drawTwo' && card.type === 'drawTwo') return true;
            if (this.gameState.stackType === 'wildDrawFour' && card.type === 'wildDrawFour') return true;
            if (this.gameRules.shieldCards && card.type === 'shield') return true;
            return false;
        }
        
        if (card.color === 'black' || card.type === 'shield') return true;
        if (this.gameRules.sharePain && card.type === 'sharePain') return true;
        
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

    scheduleComputerTurn() {
        this.clearComputerThinkTimer();
        const computerThinkTime = Math.random() * 2000 + 2000;
        
        this.computerThinkTimer = setTimeout(() => {
            if (this.gameState && !this.gameState.isGameOver) {
                this.computerTurn();
            }
        }, computerThinkTime);
    }

    clearComputerThinkTimer() {
        if (this.computerThinkTimer) {
            clearTimeout(this.computerThinkTimer);
            this.computerThinkTimer = null;
        }
    }

    nextTurn() {
        if (!this.gameState) return; // 防止遊戲結束後調用
        
        this.gameState.showedUno = this.gameState.showedUno.filter(playerId => {
            const player = this.gameState.players.find(p => p.id === playerId);
            return player && player.hand.length === 1;
        });

        this.gameState.currentPlayerIndex = this.getNextPlayerIndex();
        
        if (this.gameState.skipNextPlayer) {
            this.gameState.currentPlayerIndex = this.getNextPlayerIndex();
            this.gameState.skipNextPlayer = false;
        }
        
        this.gameState.playerHasDrawnThisTurn = false;
        
        if (!this.gameState.waitingForColorSelection) {
            this.gameState.turnStartTime = Date.now();
            this.turnStartTime = Date.now();
            
            const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
            if (currentPlayer.isComputer) {
                this.scheduleComputerTurn();
            } else {
                this.startTurnTimer();
            }
        }
    }

    startTurnTimer() {
        this.clearTurnTimer();
        
        this.turnTimer = setTimeout(() => {
            if (!this.gameState || this.gameState.isGameOver) return;
            
            this.handleTurnTimeout();
        }, this.turnTimerDuration);
    }

    handleTurnTimeout() {
        this.clearTurnTimer();
        if (!this.gameState) return; // 防止遊戲結束後調用
        
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        const currentPlayerId = currentPlayer.id;
        
        let penaltyResult = { drawnCards: [] };
        
        if (!this.gameState.playerHasDrawnThisTurn) {
            if (this.gameState.isStackActive) {
                penaltyResult = this.applyPenaltyCards(currentPlayerId, this.gameState.stackPenalty, 'timeout');
                this.gameState.isStackActive = false;
                this.gameState.stackPenalty = 0;
                this.gameState.stackType = null;
            } else {
                penaltyResult = this.applyPenaltyCards(currentPlayerId, 1, 'timeout');
            }
        }
        
        const result = { 
            timeout: true, 
            forceEndTurn: true,
            ...penaltyResult
        };
        const move = { type: 'timeout', playerId: currentPlayerId };

        this.gameState.waitingForColorSelection = false;
        
        const isComputer = currentPlayer && currentPlayer.isComputer;
        const durations = isComputer ? ANIMATION_DURATIONS.COMPUTER : ANIMATION_DURATIONS;
        
        let baseDuration = durations.TIMEOUT;
        const drawAnimationTime = calculateDrawAnimationTime(penaltyResult.drawnCards.length, isComputer);
        let totalDuration = baseDuration + drawAnimationTime;
        
        // 如果觸發了同甘共苦，需要額外的動畫時間
        if (penaltyResult.sharePainTriggered) {
            totalDuration += durations.SHARE_PAIN_TRIGGER;
        }

        this.pauseAndResume(totalDuration, move, result, currentPlayerId);
    }

    clearTurnTimer() {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.turnTimer = null;
        }
    }

    computerTurn() {
        if (!this.gameState) return; // 防止遊戲結束後調用
        if (this.gameState.waitingForColorSelection) return;
        const computer = this.gameState.players[this.gameState.currentPlayerIndex];
        if (!computer || !computer.isComputer || this.gameState.isGameOver) {
            return;
        }

        console.log(`電腦 ${computer.name} 開始思考...`);

        const topCard = this.gameState.discardPile[this.gameState.discardPile.length - 1];
        
        if (this.gameState.isStackActive && this.gameRules.shieldCards) {
            const shieldIndex = computer.hand.findIndex(card => card.type === 'shield');
            if (shieldIndex !== -1) {
                const handCount = computer.hand.length;
                const penalty = this.gameState.stackPenalty;
                
                let shouldUseShield = false;
                
                if (penalty >= 4) {
                    shouldUseShield = true;
                } else if (penalty >= 2 && handCount >= 6) {
                    shouldUseShield = Math.random() < 0.85;
                } else if (penalty >= 2 && handCount <= 2) {
                    shouldUseShield = Math.random() < 0.95;
                } else if (penalty >= 2 && handCount <= 4) {
                    shouldUseShield = Math.random() < 0.75;
                } else if (penalty >= 2) {
                    shouldUseShield = Math.random() < 0.45;
                }
                
                if (shouldUseShield) {
                    const result = this.playCard(computer.id, shieldIndex);
                    // 由於統一使用動畫系統，所有操作都會返回 needsServerContinuation
                    return;
                }
            }
        }
        
        let playableCardIndex = -1;
        let isSharePainCard = false;
        
        for (let i = 0; i < computer.hand.length; i++) {
            if (this.isCardPlayable(computer.hand[i], topCard, computer.hand.length)) {
                playableCardIndex = i;
                if (computer.hand[i].type === 'sharePain') {
                    isSharePainCard = true;
                }
                break;
            }
        }

        let result;
        let move;

        if (playableCardIndex !== -1) {
            if (isSharePainCard && this.gameRules.sharePain) {
                const availableTargets = this.gameState.players.filter(p => p.id !== computer.id);
                let selectedTarget = null;
                
                if (availableTargets.length > 0) {
                    selectedTarget = availableTargets.reduce((max, player) => 
                        (player.hand.length > max.hand.length) ? player : max
                    );
                    
                    result = this.playSharePainCard(computer.id, playableCardIndex, selectedTarget.id);
                    move = { type: 'playSharePainCard', cardIndex: playableCardIndex, playerId: computer.id, targetPlayerId: selectedTarget.id };
                } else {
                    playableCardIndex = -1;
                    for (let i = 0; i < computer.hand.length; i++) {
                        if (this.isCardPlayable(computer.hand[i], topCard, computer.hand.length) && computer.hand[i].type !== 'sharePain') {
                            playableCardIndex = i;
                            break;
                        }
                    }
                    
                    if (playableCardIndex !== -1) {
                        result = this.playCard(computer.id, playableCardIndex);
                        move = { type: 'playCard', cardIndex: playableCardIndex, playerId: computer.id };
                    }
                }
            } else {
                result = this.playCard(computer.id, playableCardIndex);
                move = { type: 'playCard', cardIndex: playableCardIndex, playerId: computer.id };
            }
            
            // 如果需要選色，設置延遲選色邏輯，但不阻止動畫系統
            if (result && result.needColorSelection) {
                const colorThinkTime = Math.random() * 1000 + 1000;
                
                setTimeout(() => {
                    // 確保遊戲狀態仍然存在且在等待選色
                    if (!this.gameState || !this.gameState.waitingForColorSelection) return;
                    
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
                    
                    console.log(`Computer selecting color: ${bestColor}`);
                    this.selectColor(computer.id, bestColor);
                    
                    // 檢查遊戲是否結束
                    if (result && result.winner) {
                        this.clearTurnTimer();
                        this.clearComputerThinkTimer();
                        this.io.to(this.roomId).emit('gameOver', { winner: result.winner });
                    }
                }, colorThinkTime + 1000); // 減少延遲時間
            }
        } else {
            result = this.drawCard(computer.id);
            move = { type: 'drawCard', playerId: computer.id };
            
            if (result && result.success && !result.drewPenalty && result.canPlayDrawnCard) {
                const secondThinkTime = Math.random() * 1500 + 1500;
                setTimeout(() => {
                    if (!this.gameState) return; // 防止遊戲結束後調用
                    
                    const drawnCardIndex = computer.hand.length - 1;
                    const drawnCard = computer.hand[drawnCardIndex];
                    let playResult;
                    
                    if (drawnCard.type === 'sharePain' && this.gameRules && this.gameRules.sharePain) {
                        const availableTargets = this.gameState.players.filter(p => p.id !== computer.id);
                        if (availableTargets.length > 0) {
                            const selectedTarget = availableTargets.reduce((max, player) => 
                                (player.hand.length > max.hand.length) ? player : max
                            );
                            
                            playResult = this.playSharePainCard(computer.id, drawnCardIndex, selectedTarget.id);
                        } else {
                            return;
                        }
                    } else {
                        playResult = this.playCard(computer.id, drawnCardIndex);
                    }
                    
                    // 如果需要選色，設置延遲選色邏輯，但不阻止動畫系統
                    if (playResult && playResult.needColorSelection) {
                        const colorThinkTime = Math.random() * 1000 + 1000;
                        
                        setTimeout(() => {
                            // 確保遊戲狀態仍然存在且在等待選色
                            if (!this.gameState || !this.gameState.waitingForColorSelection) return;
                            
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
                            
                            console.log(`Computer selecting color after draw: ${bestColor}`);
                            this.selectColor(computer.id, bestColor);
                            
                            // 檢查遊戲是否結束
                            if (playResult && playResult.winner) {
                                this.clearTurnTimer();
                                this.clearComputerThinkTimer();
                                this.io.to(this.roomId).emit('gameOver', { winner: playResult.winner });
                            }
                        }, colorThinkTime + 1000); // 減少延遲時間
                    }
                    
                    if (playResult && playResult.winner) {
                        this.clearTurnTimer();
                        this.clearComputerThinkTimer();
                        this.io.to(this.roomId).emit('gameOver', { winner: playResult.winner });
                    }
                }, secondThinkTime);
                return;
            }
        }

        // 統一使用動畫系統後，所有操作都由 pauseAndResume 處理
        if (result && result.winner) {
            this.clearTurnTimer();
            this.clearComputerThinkTimer();
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
        this.clearComputerThinkTimer();
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
                    room.scheduleComputerTurn();
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
        
        if (result && result.success) {
            if (!result.needsServerContinuation) {
                room.broadcastGameUpdate({ ...move, playerId: playerInfo.playerId }, result);
            }
            
            if (result.winner) {
                io.to(playerInfo.roomId).emit('gameOver', {
                    winner: result.winner
                });
            }
        } else if (result && result.error) {
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
                        room.clearComputerThinkTimer();
                        io.to(playerInfo.roomId).emit('gameOver', {
                            winner: null,
                            reason: `${playerInfo.playerName || '一位玩家'} 已中離`
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
