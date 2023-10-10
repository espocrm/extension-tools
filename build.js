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

const require = createRequire(import.meta.url);

const cwd = process.cwd();

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
    }

    if (helpers.hasProcessParam('install')) {
        install().then(() => {
            installExtensions().then(() => {
                setOwner().then(() => console.log('Done'));
            });
        });
    }

    if (helpers.hasProcessParam('fetch')) {
        fetchEspo({branch: branch}).then(() => console.log('Done'));
    }

    if (helpers.hasProcessParam('copy')) {
        copyExtension().then(() => {
            setOwner().then(() => console.log('Done'));
        });
    }
    if (helpers.hasProcessParam('after-install')) {
        afterInstall().then(() => console.log('Done'));
    }

    if (helpers.hasProcessParam('extension')) {
        buildExtension(options.extensionHook).then(() => console.log('Done'));
    }

    if (helpers.hasProcessParam('rebuild')) {
        rebuild().then(() => console.log('Done'));
    }

    if (helpers.hasProcessParam('composer-install')) {
        composerInstall().then(() => console.log('Done'));
    }
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

        cp.execSync(
            "php install/cli.php -a setupConfirmation -d \"host-name=" + config.database.host +
            "&db-name=" + config.database.dbname +
            "&db-platform=" + dbPlatform +
            "&db-user-name=" + config.database.user +
            "&db-user-password=" + config.database.password + "\"",
            {cwd: cwd + '/site'}
        );

        console.log('  Install: checkPermission...');

        cp.execSync("php install/cli.php -a \"checkPermission\"", {
            cwd: cwd + '/site',
            stdio: 'ignore',
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
            stdio: 'ignore',
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

    cp.execSync("npm ci", {cwd: cwd + '/site', stdio: 'ignore'});

    console.log('  Building...');

    cp.execSync("grunt", {cwd: cwd + '/site', stdio: 'ignore'});
}

function createConfig() {
    const config = helpers.loadConfig();

    let charset = config.database.charset ?
        "'" + config.database.charset + "'" : 'null';

    let port = config.database.port ?
        config.database.port : 'null';

    let configString = `<?php
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
        ];
    `;

    fs.writeFileSync(cwd + '/site/data/config.php', configString);
}

function copyExtension() {
    return transpile().then(() =>
        new Promise(resolve => {
            console.log('Copying extension to EspoCRM instance...');

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

            resolve();
        })
    );
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
        .then(() => {
            if (!extensionParams.bundled) {
                return;
            }

            const mod = helpers.camelCaseToHyphen(extensionParams.module);

            const modPaths = {};
            modPaths[mod] = `custom/modules/${mod}`;

            let chunks =  {
                init: {},
            };

            const chunkName = 'module-' + mod;

            chunks[chunkName] = {
                patterns: [`custom/modules/${mod}/src/**/*.js`],
                mapDependencies: true,
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

            if (!fs.existsSync('build/assets/lib')) {
                fs.mkdirSync('build/assets/lib');
            }

            // @todo Minify.
            fs.writeFileSync(cwd + '/build/assets/lib/init.js', result['init'], 'utf8');
            fs.writeFileSync(cwd + `/build/assets/lib/${chunkName}.js`, result[chunkName], 'utf8');

            return Promise.resolve();
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
 * @return {Promise<void>}
 */
function transpile() {
    if (!extensionParams.bundled) {
        return Promise.resolve();
    }

    helpers.deleteDirRecursively(cwd + `/build/assets/transpiled/custom`);

    console.log('Transpiling...');

    const moduleNameHyphen = helpers.camelCaseToHyphen(extensionParams.module);

    const transpiler = new Transpiler({
        path: `src/files/client/custom/modules/${moduleNameHyphen}`,
        mod: moduleNameHyphen,
        destDir: `build/assets/transpiled/custom`,
    });

    transpiler.process();

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
                    stdio: 'ignore',
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

        internalComposerInstall(cwd + '/site/custom/Espo/Modules/' + moduleName, true);

        resolve();
    });
}

function internalComposerInstall(modulePath, includeDev) {
    if (!fs.existsSync(modulePath + '/composer.json')) {

        return;
    }

    console.log('Running composer install...');

    let devOption = includeDev ? "" : "--no-dev";

    cp.execSync(
        `composer install ${devOption} --ignore-platform-reqs`,
        {
            cwd: modulePath,
            stdio: 'ignore',
        }
    );
}

function internalComposerBuildExtension() {
    const moduleName = extensionParams.module;

    internalComposerInstall(cwd + '/build/tmp/files/custom/Espo/Modules/' + moduleName, false);

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
