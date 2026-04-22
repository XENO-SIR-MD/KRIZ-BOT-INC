const config = require('../../config');
const axios = require('axios');
const simpleGit = require('simple-git');
const git = simpleGit();
const { exec } = require('child_process');
const fs = require('fs');

class Sparky {
    constructor() {
        this.platform = this.detectPlatform();
        
        this.koyeb = axios.create({
            baseURL: 'https://app.koyeb.com/v1',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + config.KOYEB_API_KEY
            }
        });

        this.render = axios.create({
            baseURL: 'https://api.render.com/v1',
            headers: {
                'Authorization': 'Bearer ' + config.RENDER_API_KEY
            }
        });

        this.heroku = axios.create({
            baseURL: 'https://api.heroku.com/apps/' + config.HEROKU_APP_NAME,
            headers: {
                'Authorization': 'Bearer ' + config.HEROKU_API_KEY,
                'Accept': 'application/vnd.heroku+json; version=3',
                'Content-Type': 'application/json'
            }
        });
    }

    detectPlatform() {
        if (process.env.PWD && process.env.PWD.includes('userland')) return 'LINUX';
        if (process.env.PITCHER_API_BASE_URL && process.env.PITCHER_API_BASE_URL.includes('codesandbox')) return 'CODESANDBOX';
        if (process.env.REPLIT_USER) return 'REPLIT';
        if (process.env.AWS_REGION) return 'AWS';
        if (process.env.TERMUX_VERSION) return 'TERMUX';
        if (process.env.DYNO) return 'HEROKU';
        if (process.env.KOYEB_APP_ID) return 'KOYEB';
        if (process.env.GITHUB_SERVER_URL) return 'GITHUB';
        if (process.env.RENDER) return 'RENDER';
        if (process.env.RAILWAY_SERVICE_NAME) return 'RAILWAY';
        if (process.env.NETLIFY) return 'NETLIFY';
        if (process.env.FLY_IO) return 'FLY_IO';
        if (process.env.CF_PAGES) return 'CLOUDFLARE';
        if (process.env.VERCEL) return 'VERCEL';
        return 'VPS';
    }

    async getAppData() {
        switch (this.platform) {
            case 'KOYEB': {
                const res = await this.koyeb.get('/services');
                return res.data.services.find(s => s.name === config.KOYEB_SERVICE_NAME) || false;
            }
            case 'RENDER': {
                const res = await this.render.get('/services');
                const service = res.data.find(s => s.service.name === config.RENDER_APP_NAME);
                return service ? {
                    id: service.service.id,
                    name: service.service.name,
                    region: service.service.region,
                    runtime: service.service.runtime
                } : false;
            }
            default:
                console.log('Unsupported platform:', this.platform);
                return false;
        }
    }

    async deploymentInfo() {
        switch (this.platform) {
            case 'KOYEB': {
                const appData = await this.getAppData();
                const { data } = await this.koyeb.get('/deployments?service_id=' + appData.id);
                return data.deployments[0]?.status || false;
            }
            case 'RENDER':
                return false;
            default:
                console.log('Unsupported platform.', this.platform);
                return false;
        }
    }

    async update() {
        switch (this.platform) {
            case 'KOYEB':
                try {
                    const appData = await this.getAppData();
                    await this.koyeb.post('/services/' + appData.id + '/redeploy', { 'deployment_group': 'prod' });
                    return true;
                } catch (e) {
                    console.log('Koyeb update failed: ' + e.message);
                    return false;
                }
            case 'RENDER':
                try {
                    const appData = await this.getAppData();
                    const res = await this.render.post('/services/' + appData.id + '/deploys', { 'option': 'clear' });
                    return res.status === 201;
                } catch (e) {
                    console.log('Render update failed: ' + e.message);
                    return false;
                }
            case 'VPS':
                try {
                    console.log('*Checking for updates...*');
                    await git.fetch();
                    let commits = await git.log(['main..origin/main']);
                    if (commits.total > 0) {
                        console.log('*New update found, stashing local changes...*');
                        await git.stash(['save']);
                        console.log('*Pulling latest updates...*');
                        await git.pull('origin', 'main');
                        console.log('*Updates applied successfully!*');
                        await git.stash(['pop']);
                        console.log('*Reapplying stashed changes...*');
                        if (commits.all.some(c => c.message.includes('package.json'))) {
                            await new Promise((resolve, reject) => {
                                exec('npm install', (err) => {
                                    if (err) {
                                        console.log('*Failed to install npm packages!*');
                                        reject(err);
                                    } else {
                                        console.log('*Installed npm packages successfully!*');
                                        resolve();
                                    }
                                });
                            });
                        }
                        return true;
                    }
                    console.log('*No updates found.*');
                    return false;
                } catch (e) {
                    console.log('VPS update failed: ' + e.message);
                    return false;
                }
            case 'HEROKU': {
                const commits = await git.log(['main..origin/main']);
                if (commits.total === 0) return console.log('Bot is up-to-date!');
                const { data } = await axios.get('https://api.heroku.com/apps/' + config.HEROKU_APP_NAME, {
                    headers: {
                        'Authorization': 'Bearer ' + config.HEROKU_API_KEY,
                        'Accept': 'application/vnd.heroku+json; version=3'
                    }
                });
                console.log('*Updating, please wait...*');
                await git.fetch('upstream', 'main');
                await git.reset('hard', ['FETCH_HEAD']);
                const herokuUrl = data.git_url.replace('https://', 'https://api:' + config.HEROKU_API_KEY + '@');
                try { await git.addRemote('heroku', herokuUrl); } catch {}
                await git.push('heroku', 'main');
                return true;
            }
            default:
                console.log('Unsupported platform:', this.platform);
                return false;
        }
    }

    async setVar(key, value) {
        key = key.toUpperCase();
        switch (this.platform) {
            case 'KOYEB': {
                const appData = await this.getAppData();
                const res = await this.koyeb.get('/deployments/' + appData.latest_deployment_id);
                const env = res.data.deployment.definition.env;
                let found = false;
                const newEnv = env.map(e => {
                    if (e.key === key) {
                        found = true;
                        return { ...e, value: value };
                    }
                    return e;
                });
                if (!found) newEnv.push({ key, value });
                const patchRes = await this.koyeb.patch('/services/' + appData.id, {
                    definition: { ...res.data.deployment.definition, env: newEnv }
                });
                return patchRes.status === 200;
            }
            case 'RENDER': {
                const appData = await this.getAppData();
                const res = await this.render.get('/services/' + appData.id + '/env-vars');
                const env = res.data.map(e => e.envVar);
                let found = false;
                const newEnv = env.map(e => {
                    if (e.key === key) {
                        found = true;
                        return { key, value };
                    }
                    return e;
                });
                if (!found) newEnv.push({ key, value });
                const putRes = await this.render.put('/services/' + appData.id + '/env-vars', newEnv);
                return putRes.status === 200;
            }
            case 'RAILWAY': {
                if (!config.RAILWAY_API_KEY) {
                    console.error("❌ Missing RAILWAY_API_KEY in config.");
                    return false;
                }
                try {
                    const query = `
                        mutation variableUpsert($input: VariableUpsertInput!) {
                            variableUpsert(input: $input)
                        }
                    `;
                    const variables = {
                        input: {
                            projectId: process.env.RAILWAY_PROJECT_ID,
                            serviceId: process.env.RAILWAY_SERVICE_ID,
                            environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
                            name: key,
                            value: value
                        }
                    };
                    const res = await axios.post('https://backboard.railway.app/graphql', { query, variables }, {
                        headers: {
                            Authorization: `Bearer ${config.RAILWAY_API_KEY}`
                        }
                    });
                    console.log(`✅ Railway: Successfully set ${key}=${value}`);
                    return res.data?.data?.variableUpsert || false;
                } catch (e) {
                    console.error('❌ Railway: Failed to set variable:', e.message);
                    return false;
                }
            }
            case 'VPS':
                try {
                    let envContent = '';
                    try { envContent = fs.readFileSync('./config.env', 'utf-8'); } catch {}
                    let lines = envContent ? envContent.trim().split('\n') : [];
                    let found = false;
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].startsWith(key + '=')) {
                            lines[i] = key + '="' + value + '"';
                            found = true;
                            break;
                        }
                    }
                    if (!found) lines.push(key + '="' + value + '"');
                    fs.writeFileSync('./config.env', lines.join('\n'));
                    console.log('✅ VPS: Successfully set ' + key + '=' + value);
                    if (key === 'SESSION') {
                        // Logic to remove session file if session changes
                        try { fs.rmSync('./lib/session', { recursive: true, force: true }); } catch {}
                    }
                    setTimeout(() => process.exit(0), 1000);
                    return true;
                } catch (e) {
                    console.log('❌ VPS: Failed to set variable:', e.message);
                    return false;
                }
            case 'HEROKU':
                if (!config.HEROKU_APP_NAME || !config.HEROKU_API_KEY) return false;
                try {
                    await this.heroku.patch('/config-vars', { [key]: value });
                    console.log('✅ Heroku: Successfully set ' + key + '=' + value);
                    return true;
                } catch (e) {
                    console.error('❌ Error setting config var on Heroku:', e.message);
                    return false;
                }
            default:
                console.log('Unsupported platform:', this.platform);
                return false;
        }
    }

    async deleteVar(key) {
        key = key.toUpperCase();
        switch (this.platform) {
            case 'KOYEB': {
                const appData = await this.getAppData();
                const res = await this.koyeb.get('/deployments/' + appData.latest_deployment_id);
                const env = res.data.deployment.definition.env;
                const newEnv = env.filter(e => e.key !== key);
                if (newEnv.length === env.length) return false;
                const patchRes = await this.koyeb.patch('/services/' + appData.id, {
                    definition: { ...res.data.deployment.definition, env: newEnv }
                });
                return patchRes.status === 200;
            }
            case 'RENDER': {
                const appData = await this.getAppData();
                const res = await this.render.get('/services/' + appData.id + '/env-vars');
                const newEnv = res.data.filter(e => e.envVar.key !== key).map(e => ({ key: e.envVar.key, value: e.envVar.value }));
                if (newEnv.length === res.data.length) return false;
                const putRes = await this.render.put('/services/' + appData.id + '/env-vars', newEnv);
                return putRes.status === 200;
            }
            case 'RAILWAY': {
                // Railway deleteVar implementation
                if (!config.RAILWAY_API_KEY) return false;
                try {
                    const query = `
                        mutation variableDelete($input: VariableDeleteInput!) {
                            variableDelete(input: $input)
                        }
                    `;
                    const variables = {
                        input: {
                            projectId: process.env.RAILWAY_PROJECT_ID,
                            serviceId: process.env.RAILWAY_SERVICE_ID,
                            environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
                            name: key
                        }
                    };
                    const res = await axios.post('https://backboard.railway.app/graphql', { query, variables }, {
                        headers: { Authorization: `Bearer ${config.RAILWAY_API_KEY}` }
                    });
                    return res.data?.data?.variableDelete || false;
                } catch (e) { return false; }
            }
            case 'VPS':
                try {
                    let envContent = fs.readFileSync('./config.env', 'utf-8');
                    let lines = envContent.trim().split('\n');
                    const newLines = lines.filter(line => !line.startsWith(key + '='));
                    if (newLines.length === lines.length) return false;
                    fs.writeFileSync('./config.env', newLines.join('\n'));
                    console.log('🗑 VPS: Successfully deleted ' + key);
                    setTimeout(() => process.exit(0), 1000);
                    return true;
                } catch { return false; }
            case 'HEROKU':
                if (!config.HEROKU_APP_NAME || !config.HEROKU_API_KEY) return false;
                try {
                    await this.heroku.patch('/config-vars', { [key]: null });
                    console.log('🗑 Heroku: Successfully deleted ' + key);
                    return true;
                } catch (e) { return false; }
            default: return false;
        }
    }

    async getVars() {
        switch (this.platform) {
            case 'KOYEB': {
                const appData = await this.getAppData();
                const res = await this.koyeb.get('/deployments/' + appData.latest_deployment_id);
                return res.data.deployment.definition.env.map(e => ({ key: e.key, value: e.value }));
            }
            case 'RENDER': {
                const appData = await this.getAppData();
                const res = await this.render.get('/services/' + appData.id + '/env-vars');
                return res.data.map(e => ({ key: e.envVar.key, value: e.envVar.value }));
            }
            case 'RAILWAY': {
                // Fetching vars from Railway
                if (!config.RAILWAY_API_KEY) return [];
                try {
                    const query = `
                        query variables($projectId: String!, $serviceId: String!, $environmentId: String!) {
                            variables(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId)
                        }
                    `;
                    const variables = {
                        projectId: process.env.RAILWAY_PROJECT_ID,
                        serviceId: process.env.RAILWAY_SERVICE_ID,
                        environmentId: process.env.RAILWAY_ENVIRONMENT_ID
                    };
                    const res = await axios.post('https://backboard.railway.app/graphql', { query, variables }, {
                        headers: { Authorization: `Bearer ${config.RAILWAY_API_KEY}` }
                    });
                    const vars = res.data?.data?.variables || {};
                    return Object.entries(vars).map(([key, value]) => ({ key, value }));
                } catch { return []; }
            }
            case 'VPS':
                try {
                    const envContent = fs.readFileSync('./config.env', 'utf-8');
                    return envContent.trim().split('\n').filter(Boolean).map(line => {
                        const [key, ...valParts] = line.split('=');
                        let val = valParts.join('=') || '';
                        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
                        return { key: key.trim(), value: val };
                    });
                } catch { return []; }
            case 'HEROKU':
                try {
                    const { data } = await this.heroku.get('/config-vars');
                    return Object.entries(data).map(([key, value]) => ({ key, value }));
                } catch { return []; }
            default: return [];
        }
    }
}

module.exports = Sparky;
