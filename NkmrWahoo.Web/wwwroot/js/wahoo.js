window.wahooBluetooth = {
    device: null,
    server: null,
    powerCharacteristic: null,
    controlPointCharacteristic: null,
    indoorBikeCharacteristic: null,
    isMock: false,
    mockInterval: null,
    mockTargetPower: 150,
    
    // Suivi précis de la cadence
    lastCrankRevs: undefined,
    lastCrankTime: undefined,
    lastCrankEventTimestamp: 0,
    lastCadenceSent: 0,
    cadenceWatchdog: null,
    
    connect: async function (dotNetHelper, useMock = false) {
        this.isMock = useMock;
        
        // Nettoyage préalable
        this.resetCadenceState();
        
        if (useMock) {
            console.log("Démarrage du mode simulation (Mock)...");
            this.mockTargetPower = 150;
            
            this.mockInterval = setInterval(() => {
                let fluctuation = (Math.random() * 0.1 - 0.05) * this.mockTargetPower;
                let current = Math.round(this.mockTargetPower + fluctuation);
                if (current < 0) current = 0;
                dotNetHelper.invokeMethodAsync('UpdatePower', current);
                
                let mockCadence = Math.round(70 + (current / 10) + (Math.random() * 4 - 2));
                dotNetHelper.invokeMethodAsync('UpdateCadence', mockCadence);
            }, 1000);
            
            return "Connecté avec succès (SIMULATEUR)";
        }

        try {
            console.log("Requesting Bluetooth Device...");
            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ services: ['cycling_power'] }, { services: ['fitness_machine'] }],
                optionalServices: ['cycling_power', 'fitness_machine']
            });

            console.log("Connecting to GATT Server...");
            this.server = await this.device.gatt.connect();

            // 1. Service Cycling Power (Watts + Cadence par révolutions de manivelle)
            try {
                console.log("Getting Cycling Power Service...");
                const cpService = await this.server.getPrimaryService('cycling_power');
                this.powerCharacteristic = await cpService.getCharacteristic('cycling_power_measurement');
                
                await this.powerCharacteristic.startNotifications();
                this.powerCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
                    let value = event.target.value;
                    let flags = value.getUint16(0, true);
                    let power = value.getInt16(2, true);
                    dotNetHelper.invokeMethodAsync('UpdatePower', power);

                    // Décalage pour trouver les données de manivelle (Crank Revolution Data)
                    let offset = 4;
                    if ((flags & 1) !== 0) offset += 1; // Pedal Power Balance
                    if ((flags & 4) !== 0) offset += 2; // Accumulated Torque
                    if ((flags & 16) !== 0) offset += 6; // Wheel Revolution Data

                    if ((flags & 32) !== 0) { // Crank Revolution Data présent
                        let crankRevs = value.getUint16(offset, true);
                        let crankTime = value.getUint16(offset + 2, true);
                        let now = Date.now();
                        
                        if (this.lastCrankTime !== undefined) {
                            let timeDiff = crankTime - this.lastCrankTime;
                            if (timeDiff < 0) timeDiff += 65536; // Résolution 1/1024s (overflow 16-bit)
                            
                            let revDiff = crankRevs - this.lastCrankRevs;
                            if (revDiff < 0) revDiff += 65536;

                            if (revDiff > 0 && timeDiff > 0) {
                                // Pédalage actif détecté
                                let cadence = Math.round((revDiff * 1024 * 60) / timeDiff);
                                if (cadence > 0 && cadence < 250) {
                                    this.lastCrankEventTimestamp = now;
                                    this.lastCadenceSent = cadence;
                                    dotNetHelper.invokeMethodAsync('UpdateCadence', cadence);
                                }
                                this.lastCrankRevs = crankRevs;
                                this.lastCrankTime = crankTime;
                            } else {
                                // Pas de nouveau tour de pédale (revDiff == 0 ou timeDiff == 0)
                                let elapsed = now - this.lastCrankEventTimestamp;
                                // Si arrêt de pédalage depuis plus de 1.2s ou puissance à 0 depuis plus de 800ms
                                if (elapsed > 1200 || (power === 0 && elapsed > 800)) {
                                    if (this.lastCadenceSent !== 0) {
                                        this.lastCadenceSent = 0;
                                        dotNetHelper.invokeMethodAsync('UpdateCadence', 0);
                                    }
                                }
                            }
                        } else {
                            this.lastCrankRevs = crankRevs;
                            this.lastCrankTime = crankTime;
                            this.lastCrankEventTimestamp = now;
                        }
                    }
                });
            } catch (e) {
                console.warn("Cycling power service not available:", e);
            }

            // 2. Service Fitness Machine (FTMS) pour contrôle ERG et cadence directe si dispo
            try {
                console.log("Getting Fitness Machine Service...");
                const ftmsService = await this.server.getPrimaryService('fitness_machine');
                
                // Point de contrôle ERG
                this.controlPointCharacteristic = await ftmsService.getCharacteristic('fitness_machine_control_point');
                console.log("Requesting FTMS control...");
                await this.controlPointCharacteristic.writeValue(new Uint8Array([0x00])); // 0x00 : Request Control
                console.log("FTMS control granted.");

                // Essai d'écoute de la cadence instantanée native FTMS (indoor_bike_data)
                try {
                    this.indoorBikeCharacteristic = await ftmsService.getCharacteristic('indoor_bike_data');
                    await this.indoorBikeCharacteristic.startNotifications();
                    this.indoorBikeCharacteristic.addEventListener('characteristicvaluechanged', (evt) => {
                        let val = evt.target.value;
                        let f = val.getUint16(0, true);
                        let off = 2;
                        if ((f & 1) === 0) off += 2; // Instantaneous Speed
                        if ((f & 2) !== 0) off += 2; // Average Speed
                        if ((f & 4) !== 0) { // Instantaneous Cadence présent (0.5 RPM)
                            let instantCadence = Math.round(val.getUint16(off, true) * 0.5);
                            this.lastCrankEventTimestamp = Date.now();
                            this.lastCadenceSent = instantCadence;
                            dotNetHelper.invokeMethodAsync('UpdateCadence', instantCadence);
                        }
                    });
                    console.log("FTMS Indoor Bike Data cadence actif.");
                } catch(err) {
                    console.log("FTMS Indoor Bike Data non requis ou indisponible, calcul via CrankRevs actif.");
                }
            } catch(e) {
                console.warn("FTMS service not available:", e);
            }

            // 3. Watchdog actif : vérifie toutes les 250ms si le cycliste a arrêté de pédaler
            if (this.cadenceWatchdog) clearInterval(this.cadenceWatchdog);
            this.cadenceWatchdog = setInterval(() => {
                let now = Date.now();
                if (this.lastCrankEventTimestamp > 0 && (now - this.lastCrankEventTimestamp > 1400)) {
                    if (this.lastCadenceSent !== 0) {
                        this.lastCadenceSent = 0;
                        dotNetHelper.invokeMethodAsync('UpdateCadence', 0);
                    }
                }
            }, 250);

            console.log("Connected.");
            return "Connecté avec succès";
        } catch (error) {
            console.error("Bluetooth connection failed", error);
            return error.toString();
        }
    },

    resetCadenceState: function () {
        if (this.cadenceWatchdog) {
            clearInterval(this.cadenceWatchdog);
            this.cadenceWatchdog = null;
        }
        this.lastCrankRevs = undefined;
        this.lastCrankTime = undefined;
        this.lastCrankEventTimestamp = 0;
        this.lastCadenceSent = 0;
    },

    setTargetPower: async function (power) {
        if (this.isMock) {
            console.log("SIMULATEUR: Target power set to " + power + "W");
            this.mockTargetPower = power;
            return true;
        }

        if (!this.controlPointCharacteristic) {
            console.error("FTMS Control point not available.");
            return false;
        }
        try {
            // Op code 0x05 : Set Target Power (SINT16, little-endian)
            const buffer = new ArrayBuffer(3);
            const view = new DataView(buffer);
            view.setUint8(0, 0x05); // Op Code
            view.setInt16(1, power, true); // Power in Watts
            
            await this.controlPointCharacteristic.writeValue(buffer);
            console.log("Target power set to " + power + "W");
            return true;
        } catch(e) {
            console.error("Failed to set target power", e);
            return false;
        }
    },

    disconnect: function () {
        this.resetCadenceState();

        if (this.isMock) {
            if (this.mockInterval) clearInterval(this.mockInterval);
            console.log("SIMULATEUR: Disconnected");
            this.isMock = false;
            return;
        }
        
        if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
            console.log("Disconnected");
        }
    }
};

window.workoutScreen = {
    wakeLock: null,
    wakeLockRequested: false,
    _visibilityBound: false,

    requestWakeLock: async function () {
        this.wakeLockRequested = true;
        try {
            if ('wakeLock' in navigator) {
                if (!this.wakeLock || this.wakeLock.released) {
                    this.wakeLock = await navigator.wakeLock.request('screen');
                    this.wakeLock.addEventListener('release', () => {
                        console.log('Screen Wake Lock relâché');
                    });
                    console.log('Screen Wake Lock actif : écran maintenu allumé.');
                }
            } else {
                console.warn('Screen Wake Lock API non supportée sur ce navigateur.');
            }
        } catch (err) {
            console.warn('Screen Wake Lock refusé ou erreur:', err);
        }

        if (!this._visibilityBound) {
            this._visibilityBound = true;
            document.addEventListener('visibilitychange', async () => {
                if (this.wakeLockRequested && document.visibilityState === 'visible') {
                    await this.requestWakeLock();
                }
            });
        }
    },

    releaseWakeLock: function () {
        this.wakeLockRequested = false;
        if (this.wakeLock !== null) {
            try {
                this.wakeLock.release();
            } catch (e) { }
            this.wakeLock = null;
            console.log('Screen Wake Lock désactivé.');
        }
    },

    lockLandscape: async function () {
        try {
            if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
                await document.documentElement.requestFullscreen();
            }
            if (screen.orientation && screen.orientation.lock) {
                await screen.orientation.lock("landscape");
            }
        } catch (e) {
            console.warn("Orientation lock not supported or denied:", e);
        }
    },
    unlockOrientation: async function () {
        try {
            if (screen.orientation && screen.orientation.unlock) {
                screen.orientation.unlock();
            }
            if (document.exitFullscreen && document.fullscreenElement) {
                await document.exitFullscreen();
            }
        } catch (e) { }
    },
    scrollToActiveStep: function (elementId) {
        const el = document.getElementById(elementId);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    },
    toggleFullscreen: async function () {
        try {
            if (!document.fullscreenElement) {
                if (document.documentElement.requestFullscreen) {
                    await document.documentElement.requestFullscreen();
                }
                if (screen.orientation && screen.orientation.lock) {
                    await screen.orientation.lock("landscape");
                }
                return true;
            } else {
                if (document.exitFullscreen) {
                    await document.exitFullscreen();
                }
                if (screen.orientation && screen.orientation.unlock) {
                    screen.orientation.unlock();
                }
                return false;
            }
        } catch (e) {
            console.warn("Fullscreen toggle error:", e);
            return !!document.fullscreenElement;
        }
    },
    isFullscreen: function () {
        return !!document.fullscreenElement;
    }
};

window.tronHighway = {
    canvas: null,
    ctx: null,
    animId: null,
    lastTime: 0,
    travelZ: 0,
    width: 0,
    height: 0,
    _resizeHandler: null,

    // Valeurs d'état lissées pour transitions douces
    targetSpeed: 25,
    currentSpeed: 25,
    targetHorizonYRatio: 0.55,
    currentHorizonYRatio: 0.55,
    targetColor: "#38bdf8",
    currentColor: [56, 189, 248],
    targetRgb: [56, 189, 248],
    cadence: 0,
    power: 0,
    isRunning: false,
    slopePercent: 0,
    targetWatts: 0,
    remainingSeconds: 999,

    init: function (canvasId) {
        this.dispose();
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        if (!this.ctx) return;

        this.resize();
        this._resizeHandler = () => this.resize();
        window.addEventListener('resize', this._resizeHandler);

        this.lastTime = performance.now();
        const renderLoop = (time) => {
            this.render(time);
            this.animId = requestAnimationFrame(renderLoop);
        };
        this.animId = requestAnimationFrame(renderLoop);
    },

    resize: function () {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.width = rect.width;
        this.height = rect.height;
        this.canvas.width = Math.max(10, Math.floor(rect.width * dpr));
        this.canvas.height = Math.max(10, Math.floor(rect.height * dpr));
        if (this.ctx) {
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
    },

    update: function (speedKmh, cadence, targetRatio, currentPower, isRunning, zoneColorHex, targetWatts, remainingSeconds) {
        this.cadence = cadence || 0;
        this.power = currentPower || 0;
        this.isRunning = isRunning;
        this.targetWatts = targetWatts || 0;
        this.remainingSeconds = (remainingSeconds !== undefined) ? remainingSeconds : 999;

        // Vitesse d'animation : réelle ou basée sur cadence
        let spd = speedKmh || 0;
        if (spd <= 0 && cadence > 0) spd = cadence * 0.35;
        if (spd <= 0 && isRunning) spd = 10;
        if (!isRunning) spd = 0;
        this.targetSpeed = spd;

        // Pente calculée d'après l'effort (ratio FTP)
        const ratio = Math.max(0.4, Math.min(targetRatio || 1.0, 1.8));
        this.slopePercent = Math.round((ratio - 0.75) * 12 * 10) / 10;

        // L'horizon s'élève lors des fortes montées / efforts élevés
        const horizonNorm = 0.58 - (ratio - 0.5) * 0.22;
        this.targetHorizonYRatio = Math.max(0.26, Math.min(0.68, horizonNorm));

        // Teinte de la zone
        if (zoneColorHex) {
            this.targetColor = zoneColorHex;
            this.targetRgb = this.hexToRgb(zoneColorHex);
        }
    },

    hexToRgb: function (hex) {
        hex = (hex || "#38bdf8").replace('#', '');
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }
        const num = parseInt(hex, 16);
        return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
    },

    render: function (now) {
        if (!this.ctx || !this.width || !this.height) return;

        const dt = Math.min((now - this.lastTime) / 1000, 0.1);
        this.lastTime = now;

        const W = this.width;
        const H = this.height;
        const ctx = this.ctx;

        // Lissage dynamique des variables (effet d'inertie sportive)
        this.currentSpeed += (this.targetSpeed - this.currentSpeed) * Math.min(dt * 3.5, 1);
        this.currentHorizonYRatio += (this.targetHorizonYRatio - this.currentHorizonYRatio) * Math.min(dt * 2.5, 1);
        for (let i = 0; i < 3; i++) {
            this.currentColor[i] += (this.targetRgb[i] - this.currentColor[i]) * Math.min(dt * 3.5, 1);
        }
        const [r, g, b] = this.currentColor.map(v => Math.round(v));
        const zoneCol = `rgb(${r},${g},${b})`;
        const zoneColAlpha = (a) => `rgba(${r},${g},${b},${a})`;

        // Avance sur la route
        this.travelZ += this.currentSpeed * 2.2 * dt;

        const hy = H * this.currentHorizonYRatio;
        const cx = W / 2;

        // 1. Fond sombre néon
        ctx.clearRect(0, 0, W, H);
        const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
        bgGrad.addColorStop(0, '#04060d');
        bgGrad.addColorStop(Math.max(0, Math.min(1, hy / H)), '#090e1f');
        bgGrad.addColorStop(1, '#05070f');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        // 2. Halo d'horizon
        const sunRadius = Math.min(W * 0.16, 75);
        const sunGrad = ctx.createRadialGradient(cx, hy, 2, cx, hy, sunRadius * 1.6);
        sunGrad.addColorStop(0, zoneColAlpha(0.35));
        sunGrad.addColorStop(0.5, zoneColAlpha(0.1));
        sunGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = sunGrad;
        ctx.beginPath();
        ctx.arc(cx, hy, sunRadius * 1.6, 0, Math.PI * 2);
        ctx.fill();

        // Ligne d'horizon néon
        ctx.save();
        ctx.strokeStyle = zoneColAlpha(0.85);
        ctx.lineWidth = 2;
        ctx.shadowColor = zoneCol;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(0, hy);
        ctx.lineTo(W, hy);
        ctx.stroke();
        ctx.restore();

        // 3. Montagnes filaires à l'horizon (qui grandissent avec la difficulté)
        const mountainHeight = (0.7 - this.currentHorizonYRatio) * (H * 0.85);
        if (mountainHeight > 5) {
            ctx.save();
            ctx.strokeStyle = zoneColAlpha(0.32);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, hy);
            ctx.lineTo(W * 0.10, hy - mountainHeight * 0.65);
            ctx.lineTo(W * 0.19, hy - mountainHeight * 1.05);
            ctx.lineTo(W * 0.28, hy - mountainHeight * 0.4);
            ctx.lineTo(W * 0.38, hy);
            ctx.moveTo(W * 0.62, hy);
            ctx.lineTo(W * 0.72, hy - mountainHeight * 0.45);
            ctx.lineTo(W * 0.81, hy - mountainHeight * 1.0);
            ctx.lineTo(W * 0.90, hy - mountainHeight * 0.6);
            ctx.lineTo(W, hy);
            ctx.stroke();
            ctx.restore();
        }

        // 4. Projection perspective 3D
        const camH = 1.0;
        const groundH = Math.max(H - hy, 20);
        const zNear = 25;
        const zFar = 500;
        const focal = (groundH * zNear) / camH;
        const roadWorldW = 1.35;

        const project = (worldX, worldZ) => {
            const zSafe = Math.max(worldZ, 1);
            const scale = focal / zSafe;
            const screenX = cx + (worldX * scale * (W / H) * 0.5);
            const screenY = hy + (camH * scale);
            return { x: screenX, y: screenY, scale: scale };
        };

        // 5. Grille latérale (rayons du sol)
        ctx.save();
        ctx.strokeStyle = zoneColAlpha(0.18);
        ctx.lineWidth = 1;
        const numRays = 8;
        for (let i = 1; i <= numRays; i++) {
            const rayX = (W / numRays) * i;
            ctx.beginPath();
            ctx.moveTo(cx, hy);
            ctx.lineTo(rayX, H);
            ctx.stroke();
        }

        // 6. Ruban de la route (remplissage dégradé sombre)
        const pTopLeft = project(-roadWorldW / 2, zFar);
        const pTopRight = project(roadWorldW / 2, zFar);
        const pBottomLeft = project(-roadWorldW / 2, zNear);
        const pBottomRight = project(roadWorldW / 2, zNear);

        const roadGrad = ctx.createLinearGradient(0, hy, 0, H);
        roadGrad.addColorStop(0, zoneColAlpha(0.08));
        roadGrad.addColorStop(1, zoneColAlpha(0.22));
        ctx.fillStyle = roadGrad;
        ctx.beginPath();
        ctx.moveTo(pTopLeft.x, pTopLeft.y);
        ctx.lineTo(pTopRight.x, pTopRight.y);
        ctx.lineTo(pBottomRight.x, pBottomRight.y);
        ctx.lineTo(pBottomLeft.x, pBottomLeft.y);
        ctx.closePath();
        ctx.fill();

        // 7. Barreaux horizontaux animés (rungs de la grille Tron)
        const lineSpacing = 18;
        const offset = this.travelZ % lineSpacing;

        ctx.lineWidth = 1.5;
        for (let z = zFar - offset; z >= zNear; z -= lineSpacing) {
            const pL = project(-roadWorldW / 2, z);
            const pR = project(roadWorldW / 2, z);

            if (pL.y < hy || pL.y > H) continue;

            const depthRatio = (pL.y - hy) / groundH;
            const alpha = Math.min(1, Math.max(0.1, depthRatio * depthRatio * 1.2));

            // Barreau sur la route
            ctx.strokeStyle = zoneColAlpha(alpha * 0.85);
            ctx.beginPath();
            ctx.moveTo(pL.x, pL.y);
            ctx.lineTo(pR.x, pR.y);
            ctx.stroke();

            // Rallonges latérales hors de la route
            ctx.strokeStyle = zoneColAlpha(alpha * 0.22);
            ctx.beginPath();
            ctx.moveTo(0, pL.y);
            ctx.lineTo(pL.x, pL.y);
            ctx.moveTo(pR.x, pR.y);
            ctx.lineTo(W, pR.y);
            ctx.stroke();
        }

        // 8. Rails néon extérieurs avec lueur intense
        ctx.shadowColor = zoneCol;
        ctx.shadowBlur = 12;
        ctx.lineWidth = 3;
        ctx.strokeStyle = zoneCol;

        // Rail gauche
        ctx.beginPath();
        ctx.moveTo(pTopLeft.x, pTopLeft.y);
        ctx.lineTo(pBottomLeft.x, pBottomLeft.y);
        ctx.stroke();

        // Rail droit
        ctx.beginPath();
        ctx.moveTo(pTopRight.x, pTopRight.y);
        ctx.lineTo(pBottomRight.x, pBottomRight.y);
        ctx.stroke();

        // Micro-rails intérieurs Tron
        ctx.lineWidth = 1;
        ctx.shadowBlur = 4;
        const pInnerTopL = project(-roadWorldW * 0.44, zFar);
        const pInnerTopR = project(roadWorldW * 0.44, zFar);
        const pInnerBotL = project(-roadWorldW * 0.44, zNear);
        const pInnerBotR = project(roadWorldW * 0.44, zNear);

        ctx.beginPath();
        ctx.moveTo(pInnerTopL.x, pInnerTopL.y);
        ctx.lineTo(pInnerBotL.x, pInnerBotL.y);
        ctx.moveTo(pInnerTopR.x, pInnerTopR.y);
        ctx.lineTo(pInnerBotR.x, pInnerBotR.y);
        ctx.stroke();

        // Ligne centrale en tirets animée
        ctx.setLineDash([14, 18]);
        ctx.lineDashOffset = -this.travelZ * 1.5;
        ctx.lineWidth = 2;
        ctx.strokeStyle = zoneColAlpha(0.75);
        ctx.beginPath();
        ctx.moveTo(cx, hy);
        ctx.lineTo(cx, H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // 9. Portiques / Arches cybernétiques (Losanges Tron)
        const isFinDeZone = this.isRunning && this.remainingSeconds > 0 && this.remainingSeconds <= 5;
        const blinkOn = (now % 360) < 200; // Clignotement ~2.8 Hz pour l'alerte

        const archSpacing = isFinDeZone ? 80 : 160;
        const archOffset = this.travelZ % archSpacing;
        const archWorldH = isFinDeZone ? 1.45 : 0.95; // Losanges beaucoup plus gros
        const archWorldW = roadWorldW * (isFinDeZone ? 1.70 : 1.15); // Plus larges

        for (let z = zFar - archOffset; z >= zNear; z -= archSpacing) {
            const pBaseL = project(-archWorldW / 2, z);
            const pBaseR = project(archWorldW / 2, z);

            const scale = focal / Math.max(z, 1);
            const archTopY = hy - (archWorldH * scale);

            if (pBaseL.y < hy || pBaseL.y > H + 50) continue;

            const depthRatio = Math.min(1, Math.max(0.1, (pBaseL.y - hy) / groundH));
            const chamfer = (pBaseR.x - pBaseL.x) * (isFinDeZone ? 0.28 : 0.18);

            ctx.save();
            if (isFinDeZone) {
                // Alerte clignotante éclatante
                if (blinkOn) {
                    ctx.strokeStyle = '#ffffff';
                    ctx.shadowColor = zoneCol;
                    ctx.shadowBlur = Math.min(26, 8 + depthRatio * 18);
                    ctx.lineWidth = Math.max(3.0, depthRatio * 6.5);
                } else {
                    ctx.strokeStyle = zoneColAlpha(0.3);
                    ctx.shadowColor = zoneCol;
                    ctx.shadowBlur = 6;
                    ctx.lineWidth = Math.max(1.5, depthRatio * 3.0);
                }
            } else {
                ctx.strokeStyle = zoneColAlpha(depthRatio * 0.9);
                ctx.shadowColor = zoneCol;
                ctx.shadowBlur = Math.min(14, 4 + depthRatio * 10);
                ctx.lineWidth = Math.max(1.5, depthRatio * 3.5);
            }

            // Losange / Arche filaire hexagonale
            ctx.beginPath();
            ctx.moveTo(pBaseL.x, pBaseL.y);
            ctx.lineTo(pBaseL.x, archTopY + chamfer);
            ctx.lineTo(pBaseL.x + chamfer, archTopY);
            ctx.lineTo(pBaseR.x - chamfer, archTopY);
            ctx.lineTo(pBaseR.x, archTopY + chamfer);
            ctx.lineTo(pBaseR.x, pBaseR.y);
            ctx.stroke();

            // En fin de zone, double contour intérieur pour accentuer l'effet losange
            if (isFinDeZone) {
                const innerGap = (pBaseR.x - pBaseL.x) * 0.08;
                ctx.lineWidth = Math.max(1.2, depthRatio * 2.5);
                ctx.beginPath();
                ctx.moveTo(pBaseL.x + innerGap, pBaseL.y);
                ctx.lineTo(pBaseL.x + innerGap, archTopY + chamfer + innerGap * 0.5);
                ctx.lineTo(pBaseL.x + chamfer, archTopY + innerGap * 0.8);
                ctx.lineTo(pBaseR.x - chamfer, archTopY + innerGap * 0.8);
                ctx.lineTo(pBaseR.x - innerGap, archTopY + chamfer + innerGap * 0.5);
                ctx.lineTo(pBaseR.x - innerGap, pBaseR.y);
                ctx.stroke();
            }

            ctx.restore();
        }

        // 10. Indicateurs HUD sur la ligne d'horizon
        ctx.save();
        ctx.font = 'bold 15px monospace';
        ctx.shadowColor = zoneCol;
        ctx.shadowBlur = 8;
        ctx.fillStyle = zoneColAlpha(0.95);

        // A gauche : Pente (plus gros, ex: ▲ +5.5%)
        const slopeTxt = (this.slopePercent >= 0 ? `▲ +${this.slopePercent}%` : `▼ ${this.slopePercent}%`);
        ctx.textAlign = 'left';
        ctx.fillText(slopeTxt, 18, Math.max(26, hy - 8));

        // A droite : Puissance demandée (ex: 210 W)
        if (this.targetWatts > 0) {
            ctx.textAlign = 'right';
            ctx.fillText(`${this.targetWatts} W`, W - 18, Math.max(26, hy - 8));
        }

        // Compte à rebours fin de palier au centre de l'horizon
        if (isFinDeZone) {
            ctx.textAlign = 'center';
            ctx.font = 'bold 15px monospace';
            ctx.fillStyle = blinkOn ? '#ffffff' : zoneColAlpha(0.85);
            ctx.shadowColor = blinkOn ? '#ffffff' : zoneCol;
            ctx.shadowBlur = blinkOn ? 14 : 6;
            ctx.fillText(`⏳ ${Math.ceil(this.remainingSeconds)}s`, cx, Math.max(26, hy - 8));
        }
        ctx.restore();
    },

    dispose: function () {
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
        this.canvas = null;
        this.ctx = null;
    }
};
