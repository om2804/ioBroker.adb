'use strict';

/*
 * Created with @iobroker/create-adapter v1.17.0
 */

const utils = require('@iobroker/adapter-core');
const adb = require('adbkit');

const  states =  {
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
};

class Adb extends utils.Adapter {
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
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
        const $this = this;

        this.setState('info.connection', false, true);

        this.client = adb.createClient({host: this.config.adbHostOption, port: this.config.adbPortOption});
                
        this.restoreDevices(this);
        this.trackDevices(this);
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

        if (name == states.shell.name)
        {            
            await androidDevice.shell(state.val);
        }
        else if (name == states.startApp.name)
        {
            await androidDevice.startApp(state.val);
        }
    }

    trackDevices($this) {
        this.client.trackDevices()
            .then(function (tracker) {
                $this.setState('info.connection', true, true);
                tracker.on('add', async function (device) {
                    $this.log.info('Device ' + device.id + " was plugged");
                    const androidDevice = $this.getAndroidDeviceById($this.devices, device.id);
                    if (androidDevice)
                        androidDevice.onConnected();
                });
                tracker.on('remove', async function (device) {
                    $this.log.info('Device ' + device.id + " was unplugged");
                    const androidDevice = $this.getAndroidDeviceById($this.devices, device.id);
                    if (androidDevice)
                        androidDevice.onDisconnected();
                });
                tracker.on('end', function () {
                    $this.log.info('Tracking stopped');
                });
            })
            .catch(function (err) {
                $this.log.error('Something went wrong:', err.stack);
            });
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
    restoreDevices($this) {
        $this.config.devices.forEach(device => {
            if (device.enabled) {
                const androidDevice = new AndroidDevice($this, $this.client, device.ip, device.port, device.name);
                $this.devices.push(androidDevice);
            }
        });
    }

    /**
     * @private
     */
    getAndroidDeviceById(devices, deviceId) {
        return devices.find((val, i, arr) => val.id == deviceId);
    }

    /**
     * @private
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
    }

    async connect()  {
        const $this = this;
        try {
            const id = await this.client.connect(this.ip, this.port);
            $this.id = id;       
            $this.onConnected();
            return true;
        }
        catch(e) {
            $this.onDisconnected();
            $this.adapter.log.error('Can not connect to ' + $this.name + " (" + $this.ip + '). Error: ' + e.message);
            return false;
        }
    }

    close() {
        const $this = this;
        this.client.disconnect(this.ip, this.port, function(err, id) {
            if (err) {
                $this.adapter.log.error("Disconnect error: " + err.message);
            }
        });
    }

    /**
     * Execute shell command
     * @param {string} command 
     */
    async shell(command) {
        if (!this.connection) 
        {
            if (!(await this.connect())) return;
        }

        try {
            if (command.startsWith("shell")) command = command.substring(5).trim();
            if (!command) return;

            const shellOut = await this.client.shell(this.id, command);
            const output = await adb.util.readAll(shellOut);
            const result = output.toString().trim();
            this.adapter.setState(this.getStateId(states.result), { val: result, ack: true });
        } catch (e)      {
            this.adapter.log.error(e.message);
        }
    }

    /**
     * Start an application
     * @param {*} component 
     */
    async startApp(component)
    {
        if (!component) return;
        if (component.split("/").length < 2) component += '/.MainActivity';

        await this.shell("am start -n " + component.trim());
    }

    onConnected()
    {
        this.connection = true;
        this.adapter.setState(this.getStateId(states.connection), { val: true, ack: true });
    }

    onDisconnected() {
        this.connection = false;
        this.adapter.setState(this.getStateId(states.connection), { val: false, ack: true });
    }

    
    /**
     * @private
     */
    async createDeviceObject() {
        const objectId = this.objectId;

        await this.adapter.setObjectAsync(objectId, {
            type: 'state',
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
            await this.adapter.setObjectAsync(objectId + "." + state.name, {
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
    getStateId(state)
    {
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