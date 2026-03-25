import fs from 'fs-extra';
import childProcess from 'child_process';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);

const exec = childProcess.exec;

const cwd = process.cwd();

const isObject = function (item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
};

const mergeDeep = function (target, ...sources) {
    if (!sources.length) {
        return target;
    }

    const source = sources.shift();

    if (isObject(target) && isObject(source)) {
        for (const key in source) {
            if (isObject(source[key])) {
                if (!target[key]) {
                    Object.assign(target, {[key]: {}});
                }

                mergeDeep(target[key], source[key]);
            } else {
                Object.assign(target, {[key]: source[key]});
            }
        }
    }

    return mergeDeep(target, ...sources);
};

const Export = {};

/**
 * @return {{
 *     espocrm: {
 *         repository: string,
 *         branch: string,
 *     },
 *     database: {
 *         host: string,
 *         port?: number|string|null,
 *         dbname: string,
 *         user: string,
 *         password: string,
 *         charset?: string,
 *         platform?: string,
 *     },
 *     install: Record,
 * }}
 */
Export.loadConfig = () => {
    const configDefault = require(cwd + '/config-default.json');
    let config;

    if (fs.existsSync(cwd + '/config.json')) {
        config = {};
        mergeDeep(config, configDefault, require(cwd + '/config.json'));
    } else {
        config = configDefault;
    }

    return config;
}

const execute = (command, callback) => {
    exec(command, (error, stdout) => {
        callback(stdout);
    });
};

Export.execute = execute;

/**
 *
 * @param {string} path
 * @param {string[]} keepFiles
 */
const deleteDirRecursively = (path, keepFiles = []) => {

    function isDirEmpty(path) {
        return fs.readdirSync(path).length === 0;
    }

    if (fs.existsSync(path) && fs.lstatSync(path).isDirectory()) {
        fs.readdirSync(path).forEach(file => {
            const curPath = path + "/" + file;

            if (keepFiles.includes(curPath)) {
                return;
            }

            if (fs.lstatSync(curPath).isDirectory()) {
                deleteDirRecursively(curPath, keepFiles);

                return;
            }

            fs.unlinkSync(curPath);
        });

        if (keepFiles.includes(path)) {
            return;
        }

        if (isDirEmpty(path)) {
            fs.rmdirSync(path);
        }

        return;
    }

    if (keepFiles.includes(path)) {
        return;
    }

    if (fs.existsSync(path) && fs.lstatSync(path).isFile()) {
        fs.unlinkSync(path);
    }
};

Export.deleteDirRecursively = deleteDirRecursively;

Export.getProcessParam = name => {
    /** @type {string} */
    let value;

    process.argv.forEach(item => {
        if (item.indexOf('--' + name + '=') === 0) {
            value = item.split('=', 2)[1];
        }
    });

    if (!value) {
        return undefined;
    }

    if (
        value.startsWith(`'`) && value.endsWith(`'`) ||
        value.startsWith('"') && value.endsWith('"')
    ) {
        value = value.slice(1, -1);
    }

    return value;
}

/**
 * @param {string} string
 * @return {string}
 */
Export.camelCaseToHyphen = (string => string.replace( /([a-z])([A-Z])/g, '$1-$2' ).toLowerCase());

/**
 * @return {boolean}
 */
Export.hasProcessParam = param => {
    for (const i in process.argv) {
        if (process.argv[i] === '--' + param) {
            return true;
        }
    }

    return false;
}

/**
 * @return {boolean}
 */
Export.hasAnyProcessParam = () => {
    for (const i in process.argv) {
        if (process.argv[i].startsWith('--')) {
            return true;
        }
    }

    return false;
}

export default Export;
