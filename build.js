import fs from 'fs-extra';
import archiver from 'archiver';
import cp from 'child_process';
import path from 'path';
import fetch from 'node-fetch';
import {pipeline} from 'node:stream';
import {promisify} from 'node:util';
import AdmZip from 'adm-zip';
import helpers from './helpers.js';
import {createRequire} from 'module';
import {Transpiler, Bundler, TemplateBundler} from 'espo-frontend-build-tools';
import {minify} from 'terser';

const require = createRequire(import.meta.url);

const cwd = process.cwd();

/**
 * @type {{
 *     module: string,
 *     packageName?: string,
 *     bundled?: boolean,
 *     bundle?: {
 *         requires?: string[],
 *     },
 *     scripts?: string[],
 *     name: string,
 *     description?: string,
 *     author?: string,
 *     acceptableVersions: string[],
 *     php: string[],
 * }}
 */
const extensionParams = require(cwd + '/extension.json');

const config = helpers.loadConfig();
const branch = helpers.getProcessParam('branch');

/**
 * @param {{extensionHook: function()}} [options]
 */
function buildGeneral(options = {}) {
    if (helpers.hasProcessParam('all')) {
        fetchEspo({branch: branch})
            .then(() => install())
            .then(() => installExtensions())
            .then(() => copyExtension())
            .then(() => composerInstall())
            .then(() => rebuild())
            .then(() => afterInstall())
            .then(() => setOwner())
            .then(() => console.log('Done'));

        return;
    }

    if (helpers.hasProcessParam('prepare-test')) {
        fetchEspo({branch: branch})
            .then(() => siteComposerInstallDev());

        return;
    }

    if (helpers.hasProcessParam('install')) {
        install().then(() => {
            installExtensions().then(() => {
                setOwner().then(() => console.log('Done'));
            });
        });

        return;
    }

    if (helpers.hasProcessParam('fetch')) {
        fetchEspo({branch: branch}).then(() => console.log('Done'));

        return;
    }

    if (helpers.hasProcessParam('copy')) {
        copyExtension().then(() => {
            setOwner().then(() => console.log('Done'));
        });

        return;
    }

    if (helpers.hasProcessParam('copy-file')) {
        let file = helpers.getProcessParam('file');

        if (!file) {
            console.error('No --file parameter specified.');

            return;
        }

        file = file.replaceAll('\\', '/');

        if (file.startsWith('tests/')) {
            copyFileInTests(file);

            console.log('Done');

            return;
        }

        if (!file.startsWith('src/files/')) {
            console.error('File should be in `src/files` dir.');

            return;
        }

        const realFile = file.substring(10);

        copyFile(realFile).then(() => {
            console.log('Done');
        });

        return;
    }

    if (helpers.hasProcessParam('after-install')) {
        afterInstall().then(() => console.log('Done'));

        return;
    }

    if (helpers.hasProcessParam('extension')) {
        buildExtension(options.extensionHook).then(() => console.log('Done'));

        return;
    }

    if (helpers.hasProcessParam('rebuild')) {
        rebuild().then(() => console.log('Done'));

        return;
    }

    if (helpers.hasProcessParam('composer-install')) {
        composerInstall().then(() => console.log('Done'));

        return;
    }

    if (helpers.hasAnyProcessParam()) {
        console.log("Unknown parameter.");

        process.exit(1);

        return;
    }

    const flags = [
        ['all', 'build all'],
        ['extension', 'build extension package'],
        ['copy', 'copy sources to the `site` directory'],
        ['rebuild', 'run rebuild'],
        ['prepare-test', 'fetches Espo instance and runs composer'],
        ['composer-install', 'run `composer install` for the module'],
    ]

    const msg = `\n Available flags:\n\n` + flags.map(it => ` --${it[0]} – ${it[1]};`).join('\n');

    console.log(msg);
}

export {buildGeneral};

function fetchEspo(params) {
    params = params || {};

    return new Promise((resolve) => {
        console.log('Fetching EspoCRM repository...');

        if (fs.existsSync(cwd + '/site/archive.zip')) {
            fs.unlinkSync(cwd + '/site/archive.zip');
        }

        helpers.deleteDirRecursively(cwd + '/site');

        if (!fs.existsSync(cwd + '/site')) {
            fs.mkdirSync(cwd + '/site');
        }

        let branch = params.branch || config.espocrm.branch;

        if (config.espocrm.repository.indexOf('https://github.com') === 0) {
            let repository = config.espocrm.repository;

            if (repository.slice(-4) === '.git') {
                repository = repository.slice(0, repository.length - 4);
            }

            if (repository.slice(-1) !== '/') {
                repository += '/';
            }

            let archiveUrl = repository + 'archive/' + branch + '.zip';

            console.log('  Downloading EspoCRM archive from Github...');

            fetch(archiveUrl)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`Unexpected response ${response.statusText}.`);
                    }

                    return response.body;
                })
                .then(body => {
                    const streamPipeline = promisify(pipeline);

                    return streamPipeline(body, fs.createWriteStream(cwd + '/site/archive.zip'));
                })
                .then(() => {
                    console.log('  Unzipping...');

                    const archive = new AdmZip(cwd + '/site/archive.zip');

                    archive.extractAllTo(cwd + '/site', true, true);

                    fs.unlinkSync(cwd + '/site/archive.zip');

                    helpers
                        .moveDir(
                            cwd + '/site/espocrm-' + branch.replace('/', '-'),
                            cwd + '/site'
                        )
                        .then(() => resolve());
                });
        }
        else {
            throw new Error();
        }
    });
}

function install() {
    return new Promise(resolve => {
        console.log('Installing EspoCRM instance...');

        console.log('  Creating config...');

        createConfig();
        buildEspo();

        if (fs.existsSync(cwd + '/site/install/config.php')) {
            fs.unlinkSync(cwd + '/site/install/config.php');
        }

        console.log('  Install: step1...');

        cp.execSync("php install/cli.php -a step1 -d \"user-lang=" + config.install.language + "\"",
            {cwd: cwd + '/site'});

        console.log('  Install: setupConfirmation...');

        const dbPlatform = config.database.platform ?? 'Mysql';

        let host = config.database.host;

        if (config.database.port) {
            host += ':' + config.database.port;
        }

        cp.execSync(
            "php install/cli.php -a setupConfirmation -d \"host-name=" + host +
            "&db-name=" + config.database.dbname +
            "&db-platform=" + dbPlatform +
            "&db-user-name=" + config.database.user +
            "&db-user-password=" + config.database.password + "\"",
            {cwd: cwd + '/site'}
        );

        console.log('  Install: checkPermission...');

        cp.execSync("php install/cli.php -a \"checkPermission\"", {
            cwd: cwd + '/site',
            stdio: ['ignore', 'ignore', 'pipe'],
        });

        console.log('  Install: saveSettings...');

        cp.execSync(
            "php install/cli.php -a saveSettings -d \"site-url=" + config.install.siteUrl +
            "&default-permissions-user=" + config.install.defaultOwner +
            "&default-permissions-group=" + config.install.defaultGroup + "\"",
            {cwd: cwd + '/site'}
        );

        console.log('  Install: buildDatabase...');

        cp.execSync("php install/cli.php -a \"buildDatabase\"", {
            cwd: cwd + '/site',
            stdio: ['ignore', 'ignore', 'pipe'],
        });

        console.log('  Install: createUser...');

        cp.execSync("php install/cli.php -a createUser -d \"user-name=" + config.install.adminUsername +
            '&user-pass=' + config.install.adminPassword + "\"",
            {cwd: cwd + '/site'}
        );

        console.log('  Install: finish...');

        cp.execSync("php install/cli.php -a \"finish\"", {cwd: cwd + '/site'});

        console.log('  Merge configs...');

        cp.execSync("php merge_configs.php", {cwd: cwd + '/php_scripts'});

        resolve();
    });
}

function buildEspo() {
    console.log('  Npm install...');

    cp.execSync("npm ci", {cwd: cwd + '/site', stdio: ['ignore', 'ignore', 'pipe']});

    console.log('  Composer install...');

    cp.execSync("composer install", {cwd: cwd + '/site', stdio: ['ignore', 'ignore', 'pipe']});

    console.log('  Building...');

    cp.execSync("grunt internal", {cwd: cwd + '/site', stdio: ['ignore', 'ignore', 'pipe']});
}

function siteComposerInstallDev() {
    console.log('Composer install...');

    cp.execSync("composer install --ignore-platform-reqs", {cwd: cwd + '/site', stdio: 'ignore'});
}

function createConfig() {
    const config = helpers.loadConfig();

    const charset = config.database.charset ?  `'${config.database.charset}'` : 'null';
    const port = config.database.port ? config.database.port : 'null';

    const configString = `<?php
        return [
            'database' => [
                'host' => '${config.database.host}',
                'port' => ${port},
                'charset' => ${charset},
                'dbname' => '${config.database.dbname}',
                'user' => '${config.database.user}',
                'password' => '${config.database.password}',
            ],
            'isDeveloperMode' => true,
            'useCache' => true,
            'developedModule' => '${extensionParams.module}',
        ];
    `;

    fs.writeFileSync(cwd + '/site/data/config.php', configString);
}

/**
 * @param {string} file
 * @return {Promise<void>}
 */
function copyFile(file) {
    return transpile(file).then(() => {
        const moduleName = extensionParams.module;
        const mod = helpers.camelCaseToHyphen(moduleName);

        const clientSrcPath = `client/custom/modules/${mod}/src/`;

        if (
            file.startsWith(clientSrcPath) &&
            file.endsWith('.js') &&
            extensionParams.bundled &&
            fs.existsSync(`${cwd}/build/assets/transpiled/${file.substring(7)}`)
        ) {
            fs.copySync(
                `${cwd}/build/assets/transpiled/${file.substring(7)}`,
                `${cwd}/site/client/custom/modules/${mod}/lib/transpiled/src/${file.substring(clientSrcPath.length)}`
            );

            console.log('  Copying transpiled...');
        }

        console.log('  Copying source...');

        fs.copySync(`${cwd}/src/files/${file}`, `${cwd}/site/${file}`);
    });
}

/**
 * @param {string} file
 */
function copyFileInTests(file) {
    if (!file.startsWith('tests/')) {
        return;
    }

    if (!fs.existsSync(`${cwd}/${file}`)) {
        return;
    }

    console.log('  Copying test file...');

    fs.copySync(`${cwd}/${file}`, `${cwd}/site/${file}`);
}

async function copyExtension() {
    await transpile();

    runScripts();

    const moduleName = extensionParams.module;
    const mod = helpers.camelCaseToHyphen(moduleName);

    if (fs.existsSync(cwd + '/site/custom/Espo/Modules/' + moduleName)) {
        console.log('  Removing backend files...');

        helpers.deleteDirRecursively(cwd + '/site/custom/Espo/Modules/' + moduleName);
    }

    if (fs.existsSync(cwd + '/site/client/custom/modules/' + mod)) {
        console.log('  Removing frontend files...');

        helpers.deleteDirRecursively(cwd + '/site/client/custom/modules/' + mod);
    }

    if (
        extensionParams.bundled &&
        fs.existsSync(cwd + `/build/assets/transpiled/custom/modules/${mod}/src`)
    ) {
        fs.copySync(
            cwd + `/build/assets/transpiled/custom/modules/${mod}/src`,
            cwd + `/site/client/custom/modules/${mod}/lib/transpiled/src`
        );
    }

    if (fs.existsSync(cwd + `/build/assets/lib`)) {
        fs.copySync(
            cwd + `/build/assets/lib`,
            cwd + `/site/client/custom/modules/${mod}/lib/`
        );

        try {
            // These are generated by extensions build. Not needed in the site.
            fs.unlinkSync(cwd + `/site/client/custom/modules/${mod}/lib/init.js`);
            fs.unlinkSync(cwd + `/site/client/custom/modules/${mod}/lib/module-${mod}.js`);
        } catch (e) {
            if (e.code !== 'ENOENT') {
                throw e;
            }
        }
    }

    if (fs.existsSync(cwd + '/site/tests/unit/Espo/Modules/' + moduleName)) {
        console.log('  Removing unit test files...');

        helpers.deleteDirRecursively(cwd + '/site/tests/unit/Espo/Modules/' + moduleName);
    }

    if (fs.existsSync(cwd + '/site/tests/integration/Espo/Modules/' + moduleName)) {
        console.log('  Removing integration test files...');

        helpers.deleteDirRecursively(cwd + '/site/tests/integration/Espo/Modules/' + moduleName);
    }

    console.log('  Copying files...');

    fs.copySync(cwd + '/src/files', cwd + '/site/');

    if (fs.existsSync(cwd + '/tests')) {
        fs.copySync(cwd + '/tests', cwd + '/site/tests');
    }
}

function rebuild() {
    return new Promise(resolve => {
        console.log('Rebuilding EspoCRM instance...');

        cp.execSync("php rebuild.php", {cwd: cwd + '/site'});

        resolve();
    });
}

function afterInstall () {
    return new Promise(resolve => {
        console.log('Running after-install script...');

        cp.execSync("php after_install.php", {cwd: cwd + '/php_scripts'});

        resolve();
    })
}


function runScripts() {
    const scripts = /** @type {string[]} */extensionParams.scripts || [];

    if (scripts.length) {
        console.log('  Running scripts...');
    }

    scripts.forEach(script => {
        cp.execSync(script, {cwd: cwd, stdio: ['ignore', 'ignore', 'pipe']});
    });
}

/**
 * @param {function} [hook]
 * @return {Promise}
 */
function buildExtension(hook) {
    console.log('Building extension package...');

    return transpile()
        .then(() => {
            helpers.deleteDirRecursively(cwd + `/build/assets/lib`);
        })
        .then(async () => {
            if (!extensionParams.bundled) {
                return;
            }

            const mod = helpers.camelCaseToHyphen(extensionParams.module);

            const modPaths = {};
            modPaths[mod] = `custom/modules/${mod}`;

            let chunks =  {
                init: {},
            };

            const bundleParams = extensionParams.bundle || {};

            const chunkName = 'module-' + mod;

            chunks[chunkName] = {
                patterns: [`custom/modules/${mod}/src/**/*.js`],
                mapDependencies: true,
                requires: bundleParams.requires,
            };

            const bundler = new Bundler(
                {
                    order: ['init', chunkName],
                    basePath: 'src/files/client',
                    transpiledPath: 'build/assets/transpiled',
                    modulePaths: modPaths,
                    lookupPatterns: [`custom/modules/${mod}/src/**/*.js`],
                    chunks: chunks,
                },
                [], // @todo
                `client/custom/modules/${mod}/lib/{*}.js`
            );

            const result = bundler.bundle();

            const minifiedSource = `/**LICENSE**/\n` +
                (await minify(result[chunkName])).code;

            if (!fs.existsSync(cwd + '/build/assets/lib')) {
                fs.mkdirSync(cwd + '/build/assets/lib', {recursive: true});
            }

            fs.writeFileSync(cwd + '/build/assets/lib/init.js', result['init'], 'utf8');
            fs.writeFileSync(cwd + `/build/assets/lib/${chunkName}.js`, minifiedSource, 'utf8');
        })
        .then(() => {
            if (!extensionParams.bundled) {
                return;
            }

            const mod = helpers.camelCaseToHyphen(extensionParams.module);

            const templateBundler = new TemplateBundler({
                dirs: [`src/files/client/custom/modules/${mod}/res/templates`],
                dest: `build/assets/lib/templates.tpl`,
                clientDir: `src/files/client`,
            });

            templateBundler.process();

            return Promise.resolve();
        })
        .then(() => runScripts())
        .then(() =>
            new Promise(resolve => {
                const moduleName = extensionParams.packageName ?? extensionParams.module;
                const packageNameHyphen = helpers.camelCaseToHyphen(moduleName);

                const mod = helpers.camelCaseToHyphen(extensionParams.module);

                const packageJsonFile = fs.existsSync(cwd + '/test-package.json') ?
                    cwd + '/test-package.json' : cwd + '/package.json';

                const packageParams = require(packageJsonFile);

                let manifest = {
                    name: extensionParams.name,
                    description: extensionParams.description,
                    author: extensionParams.author,
                    php: extensionParams.php,
                    acceptableVersions: extensionParams.acceptableVersions,
                    version: packageParams.version,
                    skipBackup: true,
                    releaseDate: (new Date()).toISOString().split('T')[0],
                };

                const packageFileName = packageNameHyphen + '-' + packageParams.version + '.zip';

                if (!fs.existsSync(cwd + '/build')) {
                    fs.mkdirSync(cwd + '/build');
                }

                if (fs.existsSync(cwd + '/build/tmp')) {
                    helpers.deleteDirRecursively(cwd + '/build/tmp');
                }

                if (fs.existsSync(cwd + '/build/' + packageFileName)) {
                    fs.unlinkSync(cwd + '/build/' + packageFileName);
                }

                fs.mkdirSync(cwd + '/build/tmp');

                fs.copySync(cwd + '/src', cwd + '/build/tmp');

                if (extensionParams.bundled) {
                    fs.copySync(cwd + '/build/assets/lib', cwd + `/build/tmp/files/client/custom/modules/${mod}/lib`);

                    helpers.deleteDirRecursively(`${cwd}/build/tmp/files/client/custom/modules/${mod}/src`);
                }

                internalComposerBuildExtension();

                if (hook) {
                    hook();
                }

                fs.writeFileSync(cwd + '/build/tmp/manifest.json', JSON.stringify(manifest, null, 4));

                const archive = archiver('zip');

                const zipOutput = fs.createWriteStream(cwd + '/build/' + packageFileName);

                zipOutput.on('close', () => {
                    console.log('Package has been built.');

                    helpers.deleteDirRecursively(cwd + '/build/tmp');

                    resolve();
                });


                archive.directory(cwd + '/build/tmp', '').pipe(zipOutput);
                archive.finalize();
            })
        );
}

/**
 * @param {string} [file]
 * @return {Promise<void>}
 */
function transpile(file) {
    if (!extensionParams.bundled) {
        return Promise.resolve();
    }

    const mod = helpers.camelCaseToHyphen(extensionParams.module);

    if (file && !file.startsWith(`client/custom/modules/${mod}/src/`)) {
        return Promise.resolve();
    }

    if (!file) {
        helpers.deleteDirRecursively(`${cwd}/build/assets/transpiled/custom`);
    }

    if (file) {
        //
    }

    console.log('  Transpiling...');

    const options = {
        path: `src/files/client/custom/modules/${mod}`,
        mod: mod,
        destDir: `build/assets/transpiled/custom`,
    };

    if (file) {
        options.file = `src/files/${file}`;
    }

    (new Transpiler(options)).process();

    return Promise.resolve();
}

function installExtensions() {
    return new Promise(resolve => {

        if (!fs.existsSync(cwd + '/extensions')) {
            resolve();

            return;
        }

        console.log("Installing extensions from 'extensions' directory...");

        fs.readdirSync(cwd + '/extensions/').forEach(file => {
            if (path.extname(file).toLowerCase() !== '.zip') {
                return;
            }

            console.log('  Install: ' + file);

            cp.execSync(
                "php command.php extension --file=\"../extensions/" + file + "\"",
                {
                    cwd: cwd + '/site',
                    stdio: 'ignore',
                }
            );
        });

        resolve();
    });
}

function setOwner() {
    return new Promise(resolve => {
        try {
            cp.execSync(
                "chown -R " + config.install.defaultOwner + ":" + config.install.defaultGroup + " .",
                {
                    cwd: cwd + '/site',
                    stdio: ['ignore', 'ignore', 'pipe'],
                }
            );
        }
        catch (e) {}

        resolve();
    });
}

function composerInstall() {
    return new Promise(resolve => {
        const moduleName = extensionParams.module;

        internalComposerInstall(cwd + '/site/custom/Espo/Modules/' + moduleName);

        resolve();
    });
}

function internalComposerInstall(modulePath) {
    if (!fs.existsSync(modulePath + '/composer.json')) {

        return;
    }

    console.log('Running composer install...');

    cp.execSync(
        "composer install --no-dev --ignore-platform-reqs",
        {
            cwd: modulePath,
            stdio: ['ignore', 'ignore', 'pipe'],
        }
    );
}

function internalComposerBuildExtension() {
    const moduleName = extensionParams.module;

    internalComposerInstall(cwd + '/build/tmp/files/custom/Espo/Modules/' + moduleName);

    const removedFileList = [
        'files/custom/Espo/Modules/' + moduleName + '/composer.json',
        'files/custom/Espo/Modules/' + moduleName + '/composer.lock',
        'files/custom/Espo/Modules/' + moduleName + '/composer.phar',
    ];

    removedFileList.forEach(file => {
        if (fs.existsSync(cwd + '/build/tmp/' + file)) {
            fs.unlinkSync(cwd + '/build/tmp/' + file);
        }
    });
}
