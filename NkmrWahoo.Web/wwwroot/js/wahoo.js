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
