const { execSync } = require('child_process');

module.exports = async function globalTeardown() {
    const agentNum = process.env.AGENT_NUM || '1';
    try {
        // 自分のagentタグ付きChromiumだけkill
        execSync(`pkill -f "test-agent=${agentNum}" 2>/dev/null`, { stdio: 'ignore' });
    } catch (e) {
        // killするプロセスがなくてもエラーにしない
    }
};
