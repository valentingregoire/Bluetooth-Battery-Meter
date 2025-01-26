'use strict';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import UPower from 'gi://UPowerGlib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BluetoothIndicator} from './bluetoothIndicator.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;

export const UpowerIndicator = GObject.registerClass({
}, class UpowerIndicator extends GObject.Object {
    constructor(settings, widgetInfo) {
        super();
        this._settings = settings;
        this._widgetInfo = widgetInfo;
        this._deviceIndicators = new Map();
        this._deviceList = new Map();

        this._deviceKindMapping = {
            [UPower.DeviceKind.MOUSE]: 'input-mouse',
            [UPower.DeviceKind.KEYBOARD]: 'input-keyboard',
            [UPower.DeviceKind.TOUCHPAD]: 'touchpad',
            [UPower.DeviceKind.GAMING_INPUT]: 'input-gaming',
            [UPower.DeviceKind.PEN]: 'input-tablet',
        };

        this._client = UPower.Client.new_full(null);
        this._client.connectObject(
            'device-added', () => this._sync(),
            'device-removed', (c, path) => this._removeDevice(path),
            this
        );

        this._sync();
    }

    _connectSettingsSignal(connect) {
        if (connect) {
            this._settingSignalId = this._settings.connect('changed::upower-device-list', () => {
                this._pullDevicesFromGsetting();
                this._destroyIndicators();
                this._sync();
            });
        } else if (this._settingSignalId) {
            this._settings.disconnect(this._settingSignalId);
            this._settingSignalId = null;
        }
    }

    _pullDevicesFromGsetting() {
        this._deviceList.clear();
        const deviceList = this._settings.get_strv('upower-device-list');
        if (deviceList.length !== 0) {
            for (const jsonString of deviceList) {
                const item = JSON.parse(jsonString);
                const path = item.path;
                const props = {
                    'icon': item['icon'],
                    'model': item['model'],
                    'isPresent': item['is-present'],
                    'indicatorMode': item['indicator-mode'],
                };
                this._deviceList.set(path, props);
            }
        }
    }

    _pushDevicesToGsetting() {
        const deviceList = [];
        for (const [path, props] of this._deviceList) {
            const item = {
                path,
                'icon': props.icon,
                'model': props.model,
                'is-present': props.isPresent,
                'indicator-mode': props.indicatorMode,
            };
            deviceList.push(JSON.stringify(item));
        }
        this._connectSettingsSignal(false);
        this._settings.set_strv('upower-device-list', deviceList);
        this._connectSettingsSignal(true);
        this._sync();
    }

    _addNewDeviceToList(device, deviceIcon) {
        const path = device.get_object_path();
        const props = {
            icon: deviceIcon,
            model: device.model,
            isPresent: true,
            indicatorMode: true,
        };
        this._deviceList.set(path, props);
        this._delayedUpdateDeviceGsettings();
    }

    _delayedUpdateDeviceGsettings() {
        if (this._delayedTimerId)
            GLib.source_remove(this._delayedTimerId);
        this._delayedTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._pushDevicesToGsetting();
            this._delayedTimerId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _removeDevice(path) {
        if (this._deviceList.has(path)) {
            const props = this._deviceList.get(path);
            props.isPresent = false;
            this._deviceList.set(path, props);
            this._pushDevicesToGsetting();
        }
        if (this._deviceIndicators.has(path)) {
            this._deviceIndicators.get(path)?.destroy();
            this._deviceIndicators.delete(path);
        }
    }

    _sync() {
        const udevices = this._client.get_devices();
        const supportedDevices = udevices.filter(udevice =>
            udevice.power_supply === false &&
            udevice.is_present === true &&
            udevice.percentage > 0 &&
           !udevice.native_path.startsWith('/org/bluez/')
        );

        for (const dev of supportedDevices) {
            const path = dev.get_object_path();
            if (this._deviceIndicators.has(path)) {
                if (!dev.is_present || this._deviceList.get(path).indicatorMode === false) {
                    this._deviceIndicators.get(path)?.destroy();
                    this._deviceIndicators.delete(path);
                }
                if (!dev.is_present) {
                    const props = this._deviceList.get(path);
                    props.isPresent = false;
                    this._deviceList.set(path, props);
                    this._pushDevicesToGsetting();
                }
                continue;
            }
            let props = {};
            let deviceIcon;
            if (this._deviceList.has(path)) {
                props = this._deviceList.get(path);
                if (!props.indicatorMode)
                    continue;
                if (props.model !== dev.model) {
                    props.model = dev.model;
                    this._deviceList.set(path, props);
                    this._pushDevicesToGsetting();
                }
                deviceIcon = props.icon;
            } else {
                deviceIcon = this._deviceKindMapping[dev.kind] || 'input-mouse';
                this._addNewDeviceToList(dev, deviceIcon);
            }

            const indicator = new BluetoothIndicator(this._settings, dev, 2, deviceIcon, this._widgetInfo, true);
            QuickSettingsMenu.addExternalIndicator(indicator);
            this._deviceIndicators.set(path, indicator);
        }
    }

    _destroyIndicators() {
        if (this._deviceIndicators) {
            this._deviceIndicators.forEach(indicator => indicator?.destroy());
            this._deviceIndicators.clear();
        }
    }

    destroy() {
        if (this._delayedTimerId)
            GLib.source_remove(this._delayedTimerId);
        this._delayedTimerId = null;
        if (this._settingSignalId)
            this._settings.disconnect(this._settingSignalId);
        this._settingSignalId = null;
        this._client.disconnectObject(this);
        this._client = null;
        this._destroyIndicators();
    }
});
