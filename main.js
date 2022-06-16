'use strict';

/*
 * Created with @iobroker/create-adapter v1.17.0
 */

const utils = require('@iobroker/adapter-core');
const adb = require('@devicefarmer/adbkit').Adb;

const states = {
    connection: {
        name: "connection",
        common: {
            name: "Connection status",
            type: 'boolean',
            role: 'indicator.connected',
            read: true,
            write: false,
            def: false
        }
    },
    shell: {
        name: "shell",
        common: {
            name: "Shell command",
            type: 'string',
            role: 'command',
            read: true,
            write: true
        },
    },
    result: {
        name: "result",
        common: {
            name: "Command result",
            type: 'string',
            role: 'text',
            read: true,
            write: false
        },
    },
    startApp: {
        name: "startApp",
        common: {
            name: "Start an application",
            type: 'string',
            role: 'text',
            read: true,
            write: true,
            desc: "Start an application. Specify the component name with package name prefix to create an explicit intent, such as com.example.app/.ExampleActivity."
        },
    },
    stopApp: {
        name: "stopApp",
        common: {
            name: "Stop an application",
            type: 'string',
            role: 'text',
            read: true,
            write: true,
            desc: "Stop an application. Force stop everything associated with package (the app's package name)."
        },
    },
    reboot: {
        name: "reboot",
        common: {
            name: "Reboots the device",
            type: 'boolean',
            role: 'button',
            read: true,
            write: true,
            desc: "Reboots the device",
            def: false
        },
    },
    screencap: {
        name: "screencap",
        common: {
            name: "Take screenshot",
            type: 'boolean',
            role: 'button',
            read: true,
            write: true,
            desc: "Takes a screenshot in PNG format",
            def: false
        },
    }
};

class Adb extends utils.Adapter {
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        // @ts-ignore
        super({
            ...options,
            name: 'adb',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.devices = new Array();
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.setState('info.connection', false, true);

        this.client = adb.createClient({ host: this.config.adbHostOption, port: this.config.adbPortOption });

        this.restoreDevices();
        await this.trackDevices();
        this.connectAllDevices();

        this.subscribeStates('*');
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');
            for (let i in this.devices) {
                this.devices[i].close();
                delete this.devices[i];
            }
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (!state || state.ack === true) return;
        const path = id.split(".");
        const name = path.pop();
        const objectId = path.pop();
        const androidDevice = this.getAndroidDeviceByObject(this.devices, objectId);
        if (!androidDevice) return;
        const strValue = String(state.val);

        if (name == states.shell.name) {
            await androidDevice.shell(strValue);
        }
        else if (name == states.startApp.name) {
            await androidDevice.startApp(strValue);
        }
        else if (name == states.stopApp.name) {
            await androidDevice.stopApp(strValue);
        }
        else if (name == states.reboot.name) {
            await androidDevice.reboot();
        }
        else if (name == states.screencap.name) {
            await androidDevice.screencap();
        }
    }

    async trackDevices() {
        try {
            var tracker = await this.client.trackDevices();
            this.setState('info.connection', true, true);
            tracker.on('add', async function (device) {
                this.log.info('Device ' + device.id + " was plugged");
                const androidDevice = this.getAndroidDeviceById(this.devices, device.id);
                if (androidDevice)
                    androidDevice.onConnected();
            }.bind(this));
            tracker.on('remove', async function (device) {
                this.log.info('Device ' + device.id + " was unplugged");
                const androidDevice = this.getAndroidDeviceById(this.devices, device.id);
                if (androidDevice)
                    androidDevice.onDisconnected();
            }.bind(this));
            tracker.on('end', function () {
                this.log.info('Tracking stopped');
            }.bind(this));
        } catch (err) {
            this.log.error('Something went wrong:', err.stack);
        }
    }

    connectAllDevices() {
        this.devices.forEach(async (device, valueAgain, set) => {
            await device.connect();
        });
    }

    /**
     * Restore devices from config
     * @private
     */
    restoreDevices() {
        this.config.devices.forEach((device => {
            if (device.enabled) {
                const androidDevice = new AndroidDevice(this, this.client, device.ip, device.port, device.name);
                this.devices.push(androidDevice);
            }
        }).bind(this));
    }

    /**
     * @private
     */
    getAndroidDeviceById(devices, deviceId) {
        return devices.find((val, i, arr) => val.id == deviceId);
    }

    /**
     * @private
     * @returns {AndroidDevice|undefined}
     */
    getAndroidDeviceByObject(devices, objectId) {
        return devices.find((val, i, arr) => val.objectId == objectId);
    }
}

class AndroidDevice {

    constructor(adapter, client, ip, port, name) {
        this.adapter = adapter;
        this.client = client;
        this.ip = ip;
        this.port = port;
        this.name = name;
        this.id = "";
        this.objectId = this.getObjectId(ip + ":" + port);
        this.connection = false;
        this.createDeviceObject().then();
        this.device = undefined;
    }

    /**
     * Connect to device
     */
    async connect() {
        try {
            const id = await this.client.connect(this.ip, this.port);
            this.id = id;
            this.device = this.client.getDevice(this.id);
            this.onConnected();
            return true;
        }
        catch (e) {
            this.onDisconnected();
            this.setError('Can not connect to ' + this.name + " (" + this.ip + '). ' + e.message);
            return false;
        }
    }

    /**
     * Try connect to device
     * @returns Connection status
     */
    async tryConnect() {
        if (!this.connection) {
            if (!await this.connect()) {
                return false;
            }
            await this.device.waitForDevice();
        }
        return true;
    }

    /**
     * Close connection to device
     */
    close() {
        this.client.disconnect(this.ip, this.port, function (err, id) {
            if (err) {
                this.adapter.log.error("Disconnect error: " + err.message);
            }
        }.bind(this));
    }

    /**
     * Reboot the device
     */
    async reboot() {
        if (!(await this.tryConnect())) return;

        try {
            await this.device.reboot();
        }
        catch (e) {
            this.setError(e.message);
        }
    }

    /**
     * Execute shell command
     * @param {string} command 
     */
    async shell(command) {
        if (!(await this.tryConnect())) return;

        try {
            if (command.startsWith("shell")) command = command.substring(5).trim();
            if (!command) return;

            const shellOut = await this.device.shell(command);
            const output = await adb.util.readAll(shellOut);
            const result = output.toString().trim();
            this.setResult(result);
        } catch (e) {
            this.setError(e.message);
        }
    }

    /**
     * Start an application
     * @param {string} component 
     */
    async startApp(component) {
        if (!component) return;
        if (component.split("/").length < 2) component += '/.MainActivity';

        await this.shell("am start -n " + component.trim());
    }

    /**
     * Stop an application
     * @param {string} $package 
     */
    async stopApp($package) {
        if (!$package) return;
        await this.shell("am force-stop " + $package.split("/")[0].trim());
    }

    /**
     * Take screenshot
     */
    async screencap() {
        if (!(await this.tryConnect())) return;

        try {
            const stream = await this.device.screencap();
            let output = await adb.util.readAll(stream);

            const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

            let i = 0;
            let j = 0;
            while (i < output.length) {
                if (output[i] == pngHeader[j]) {
                    j++;
                    if (j >= pngHeader.length) {
                        output = output.slice(i - pngHeader.length + 1, output.length);
                        break;
                    }
                }
                else {
                    j = 0;
                }
                i++;
            }

            this.adapter.writeFile(this.adapter.namespace, "/screenshot.png", output, function () {
                this.setResult("Screenshot taken");
            }.bind(this));
        } catch (e) {
            this.setError(e.message);
        }
    }

    onConnected() {
        this.connection = true;
        this.adapter.setState(this.getStateId(states.connection), { val: true, ack: true });
    }

    onDisconnected() {
        this.connection = false;
        this.adapter.setState(this.getStateId(states.connection), { val: false, ack: true });
    }

    /**
     * Set result command
     * @private
     * @param {string} result 
     */
    setResult(result) {
        if (!result || result.length === 0) result = "ok";
        this.adapter.setState(this.getStateId(states.result), { val: result, ack: true });
    }

    /**
     * Set error message
     * @param {string} error 
     */
    setError(error) {
        if (!error || error.length === 0) return;
        this.adapter.log.error(error);
        this.adapter.setState(this.getStateId(states.result), { val: "error: " + error, ack: true });
    }

    /**
     * @private
     */
    async createDeviceObject() {
        const objectId = this.objectId;

        await this.adapter.setObjectNotExistsAsync(objectId, {
            type: 'device',
            common: {
                name: this.name || this.id,
                type: 'string',
                role: 'device',
                read: true,
                write: false
            },
            native: {},
        });

        for (var i in states) {
            var state = states[i];
            await this.adapter.setObjectNotExistsAsync(objectId + "." + state.name, {
                type: 'state',
                common: state.common,
                native: {},
            });
        }
    }

    /**
     * @private
     */
    getObjectId(deviceId) {
        return deviceId.replace(/\./g, '_');
    }

    /**
     * @private
     */
    getStateId(state) {
        return this.objectId + "." + state.name;
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Adb(options);
} else {
    // otherwise start the instance directly
    new Adb();
}