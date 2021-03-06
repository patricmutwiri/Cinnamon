// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Cinnamon = imports.gi.Cinnamon;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Signals = imports.signals;
const St = imports.gi.St;
const CinnamonJS = imports.gi.CinnamonJS;

const AppletManager = imports.ui.appletManager;
const Config = imports.misc.config;
const DeskletManager = imports.ui.deskletManager;
const ExtensionSystem = imports.ui.extensionSystem;
const Main = imports.ui.main;

const State = {
    INITIALIZING: 0,
    LOADED: 1,
    ERROR: 2,
    OUT_OF_DATE: 3
};

// Maps uuid -> importer object (extension directory tree)
const importObjects = {};

// Maps uuid -> Extension object
const objects = {};

// Maps uuid -> metadata object
const meta = {};

/**
 * const Type:
 * @EXTENSION: Cinnamon extensions
 * @APPLET: Cinnamon panel applets
 * 
 * @name: Upper case first character name for printing messages
 *        Also converted to lowercase to find the correct javascript file
 * @folder: The folder name within the system and user cinnamon folders
 * @requiredFunctions: Functions that must exist in the main javascript file
 * @requiredProperties: Properties that must be set in the metadata.json file
 * @niceToHaveProperties: Properties that are encouraged to be set in the metadata.json file
 * @roles: Roles an extension can assume. Values will be set internally, set to null.
 *         key => name of the role, value => reference to the extension object
 * @callbacks: Callbacks used to do some manual actions on load / unload
 * 
 * Extension types with some attributes helping to load these extension types.
 * Properties are nested, with lowerCamelCase properties (e.g. requiredFunctions) as sub-properties of CAPITAL one (EXTENSION). Thus they are refered to as, e.g., Type.EXTENSION.requiredFunctions
 */
const Type = {
    EXTENSION: {
        name: 'Extension',
        folder: 'extensions',
        requiredFunctions: ['init', 'disable', 'enable'],
        requiredProperties: ['uuid', 'name', 'description', 'cinnamon-version'],
        niceToHaveProperties: ['url'],
        roles: {},
        callbacks: {
            finishExtensionLoad: ExtensionSystem.finishExtensionLoad,
            prepareExtensionUnload: ExtensionSystem.prepareExtensionUnload
        }
    },
    APPLET: {
        name: 'Applet',
        folder: 'applets',
        requiredFunctions: ['main'],
        requiredProperties: ['uuid', 'name', 'description'],
        niceToHaveProperties: [],
        roles: {
            notifications: null,
            windowlist: null,
            panellauncher: null
        },
        callbacks: {
            finishExtensionLoad: AppletManager.finishExtensionLoad,
            prepareExtensionUnload: AppletManager.prepareExtensionUnload
        }
    },
    DESKLET: {
        name: 'Desklet',
        folder: 'desklets',
        requiredFunctions: ['main'],
        requiredProperties: ['uuid', 'name', 'description'],
        niceToHaveProperties: [],
        roles: {
            notifications: null,
            windowlist: null
        },
        callbacks: {
            finishExtensionLoad: DeskletManager.finishExtensionLoad,
            prepareExtensionUnload: DeskletManager.prepareExtensionUnload
        }
    }
};

// Add signal methods to all types and create user directories if they don't exist.
for(var key in Type) {
    let type = Type[key];
    Signals.addSignalMethods(type);

    let path = GLib.build_filenamev([global.userdatadir, type.folder]);
    type.userDir = Gio.file_new_for_path(path);
    try {
        if (!type.userDir.query_exists(null))
            type.userDir.make_directory_with_parents(null);
    } catch (e) {
        global.logError(e);
    }
}

// Create a dummy metadata object when metadata parsing failed or was not done yet.
function createMetaDummy(uuid, path, state) {
    return { name: uuid, description: 'Metadata load failed', state: state, path: path, error: '' };
}

// The Extension object itself
function Extension(dir, type) {
    this._init(dir, type);
}

Extension.prototype = {
    _init: function(dir, type) {
        this.uuid = dir.get_basename();
        this.dir = dir;
        this.type = type;
        this.lowerType = type.name.toLowerCase();
        this.theme = null;
        this.stylesheet = null;
        this.meta = createMetaDummy(this.uuid, dir.get_path(), State.INITIALIZING);
        this.startTime = new Date().getTime();

        this.loadMetaData(dir.get_child('metadata.json'));
        this.validateMetaData();

        this.ensureFileExists(dir.get_child(this.lowerType + '.js'));
        this.loadStylesheet(dir.get_child('stylesheet.css'));
        
        if (this.stylesheet) {
            Main.themeManager.connect('theme-set', Lang.bind(this, function() {
                this.loadStylesheet(this.dir.get_child('stylesheet.css'));
            }));
        }

        try {
            CinnamonJS.add_extension_importer('imports.ui.extension.importObjects', this.uuid, this.meta.path);
        } catch (e) {
            throw this.logError('Error importing extension ' + this.uuid + ' from path ' + this.meta.path, e);
        }

        try {
            this.module = importObjects[this.uuid][this.lowerType]; // get [extension/applet/desklet].js
        } catch (e) {
            throw this.logError('Error importing ' + this.lowerType + '.js from ' + this.uuid, e);
        }

        for (let i = 0; i < this.type.requiredFunctions.length; i++) {
            let func = this.type.requiredFunctions[i];
            if (!this.module[func]) {
                throw this.logError('Function "' + func + '" is missing');
            }
        }

        objects[this.uuid] = this;
    },

    finalize : function() {
        this.meta.state = State.LOADED;

        this.type.emit('extension-loaded', this.uuid);

        let endTime = new Date().getTime();
        global.log('Loaded %s %s in %d ms'.format(this.lowerType, this.uuid, (endTime - this.startTime)));
    },

    formatError:function(message) {
        return '[%s "%s"]: %s'.format(this.type.name, this.uuid, message);
    },

    logError: function (message, error, state) {
        this.meta.state = state || State.ERROR;
        this.meta.error += message;

        let errorMessage = this.formatError(message);
        if(error)
            global.logError(error);
        else
            error = new Error(errorMessage);
        
        global.logError(errorMessage);

        // An error during initialization leads to unloading the extension again.
        if(this.meta.state == State.INITIALIZING) {
            this.unlockRole();
            this.unloadStylesheet();
            forgetExtension(this.uuid);
        }
        error._alreadyLogged = true;
        return error;
    },

    logWarning: function (message) {
        global.logWarning(this.formatError(message));
    },

    loadMetaData: function(metadataFile) {
        this.ensureFileExists(metadataFile);

        let oldState = this.meta.state;
        let oldPath = this.meta.path;

        try {
            let metadataContents = Cinnamon.get_file_contents_utf8_sync(metadataFile.get_path());
            this.meta = JSON.parse(metadataContents);
            
            // Store some additional crap here
            this.meta.state = oldState;
            this.meta.path = oldPath;

            meta[this.uuid] = this.meta;
        } catch (e) {
            this.meta = createMetaDummy(this.uuid, oldPath, oldState);
            meta[this.uuid] = this.meta;
            throw this.logError('Failed to load/parse metadata.json', e);
        }
    },

    validateMetaData: function() {
        // Some properties are required to run
        this.checkProperties(this.type.requiredProperties, true);

        // Others are nice to have
        this.checkProperties(this.type.niceToHaveProperties, false);

        if (this.meta.uuid != this.uuid) {
            throw this.logError('uuid "' + this.meta.uuid + '" from metadata.json does not match directory name.');
        }

        // If cinnamon or js version are set, check them
        if('cinnamon-version' in this.meta && !versionCheck(this.meta['cinnamon-version'], Config.PACKAGE_VERSION)) {
            throw this.logError('Extension is not compatible with current Cinnamon version', null, State.OUT_OF_DATE);
        }
        if('js-version' in this.meta && !versionCheck(this.meta['js-version'], Config.GJS_VERSION)) {
            throw this.logError('Extension is not compatible with current GJS version', null, State.OUT_OF_DATE);
        }

        // If a role is set, make sure it's a valid one
        let role = this.meta['role'];
        if(role) {
            if (!(role in this.type.roles)) {
                throw this.logError('Unknown role definition: ' + role + ' in metadata.json');
            }
        }
    },

    checkProperties: function(properties, fatal) {
        for (let i = 0; i < properties.length; i++) {
            let prop = properties[i];
            if (!this.meta[prop]) {
                let msg = 'Missing property "' + prop + '" in metadata.json';
                if(fatal)
                    throw this.logError(msg);
                else
                    this.logWarning(msg);
            }
        }
    },

    loadStylesheet: function (file) {
        if (file.query_exists(null)) {
            try {
                let themeContext = St.ThemeContext.get_for_stage(global.stage);
                this.theme = themeContext.get_theme();
            } catch (e) {
                throw this.logError('Error trying to get theme', e);
            }

            try {
                this.theme.load_stylesheet(file.get_path());
                this.stylesheet = file.get_path();
            } catch (e) {
                throw this.logError('Stylesheet parse error', e);
            }
        }
    },

    unloadStylesheet: function () {
        if (this.theme != null && this.stylesheet != null) {
            try {
                this.theme.unload_stylesheet(this.stylesheet);
            } catch (e) {
                global.logError('Error unloading stylesheet', e);
            }
        }
    },

    ensureFileExists: function(file) {
        if (!file.query_exists(null)) {
            throw this.logError('File not found: ' + file.get_path());
        }
    },

    lockRole: function(roleProvider) {
        let role = this.meta['role'];
        if(role && this.type.roles[role] != this) {
            if(this.type.roles[role] != null) {
                return false;
            }
        
            if(roleProvider != null) {
                this.type.roles[role] = this;
                this.roleProvider = roleProvider;
                global.log("Role locked: " + role);
                return true;
            }
        }

        return true;
    },

    unlockRole: function() {
        let role = this.meta['role'];
        if(role && this.type.roles[role] == this) {
            this.type.roles[role] = null;
            this.roleProvider = null;
            global.log("Role unlocked: " + role);
        }
    }
}

/**
* versionCheck:
* @required: an array of versions we're compatible with
* @current: the version we have
*
* Check if a component is compatible for an extension.
* @required is an array, and at least one version must match.
* @current must be in the format <major>.<minor>.<point>.<micro>
* <micro> is always ignored
* <point> is ignored if not specified (so you can target the whole release)
* <minor> and <major> must match
* Each target version must be at least <major> and <minor>
*/
function versionCheck(required, current) {
    let currentArray = current.split('.');
    let major = currentArray[0];
    let minor = currentArray[1];
    let point = currentArray[2];
    for (let i = 0; i < required.length; i++) {
        let requiredArray = required[i].split('.');
        if (requiredArray[0] == major &&
            requiredArray[1] == minor &&
            (requiredArray[2] == point || requiredArray[2] === undefined))
            return true;
    }
    return false;
}

// Returns a string version of a State value
function getMetaStateString(state) {
    switch (state) {
        case State.INITIALIZING:
            return _("Initializing");
        case State.LOADED:
            return _("Loaded");
        case State.ERROR:
            return _("Error");
        case State.OUT_OF_DATE:
            return _("Out of date");
    }
    return 'Unknown'; // Not translated, shouldn't appear
}

function loadExtension(uuid, type) {
    let extension = objects[uuid];
    if(!extension) {
        var forgetMeta = true;
        try {
            let dir = findExtensionDirectory(uuid, type);
            if (dir == null) {
                throw ("not-found");
            }
            extension = new Extension(dir, type);
            forgetMeta = false;

            if(!type.callbacks.finishExtensionLoad(extension))
                throw (type.name + ' ' + uuid + ': Could not create applet object.');

            extension.finalize();
            Main.cinnamonDBusService.EmitXletAddedComplete(true, uuid);
        } catch (e) {
            /* Silently fail to load xlets that aren't actually installed - 
               but no error, since the user can't do anything about it anyhow
               (short of editing gsettings).  Silent failure is consistent with
               other reactions in Cinnamon to missing items (e.g. panel launchers
               just don't show up if their program isn't installed, but we don't
               remove them or anything) */
            if (e == "not-found") {
                forgetExtension(uuid, forgetMeta);
                return null;
            }
            Main.cinnamonDBusService.EmitXletAddedComplete(false, uuid);
            Main.xlet_startup_error = true;
            forgetExtension(uuid, forgetMeta);
            if(e._alreadyLogged)
                e = undefined;
            global.logError('Could not load ' + type.name.toLowerCase() + ' ' + uuid, e);
            return null;
        }
    }
    return extension;
}

function unloadExtension(uuid) {
    let extension = objects[uuid];
    if (extension) {
        extension.unlockRole();

        // Try to disable it -- if it's ERROR'd, we can't guarantee that,
        // but it will be removed on next reboot, and hopefully nothing
        // broke too much.
        try {
            extension.type.callbacks.prepareExtensionUnload(extension);
        } catch(e) {
            global.logError('Error disabling ' + extension.lowerType + ' ' + extension.uuid, e);
        }
        extension.unloadStylesheet();

        extension.type.emit('extension-unloaded', extension.uuid);

        forgetExtension(extension.uuid, true);
    }
}

function forgetExtension(uuid, forgetMeta) {
    delete importObjects[uuid];
    delete objects[uuid];
    if(forgetMeta)
        delete meta[uuid];
}

function findExtensionDirectory(uuid, type) {
    let directory = findExtensionDirectoryIn(uuid, type.userDir);
    if (directory == null) {
        let systemDataDirs = GLib.get_system_data_dirs();
        for (let i = 0; i < systemDataDirs.length; i++) {
            let dirPath = systemDataDirs[i] + '/cinnamon/' + type.folder;
            let dir = Gio.file_new_for_path(dirPath);
            if (dir.query_exists(null))
                directory = findExtensionDirectoryIn(uuid, dir);
                if (directory != null) {
                    break;
                }
            }
    }
    return directory;
}

function findExtensionDirectoryIn(uuid, dir) {
    try {
        let fileEnum = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);

        let directory = null;
        let info;
        while ((info = fileEnum.next_file(null)) != null) {
            let fileType = info.get_file_type();
            if (fileType != Gio.FileType.DIRECTORY)
                continue;
            let name = info.get_name();
            if (name == uuid) {
                let child = dir.get_child(name);
                directory = child;
                break;
            }
        }

        fileEnum.close(null);
        return directory;
    } catch (e) {
        global.logError('Error looking for extension ' + uuid + ' in directory ' + dir, e);
       return null;
    }
}

function get_max_instances (uuid) {
    if (uuid in meta) {
        if ("max-instances" in meta[uuid]) {
            return parseInt(meta[uuid]["max-instances"]);
        }
    }
    return 1;
}
