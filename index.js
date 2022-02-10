const core = require('@actions/core');
const github = require('@actions/github');

const Config = require('./lib/config')
const Pull = require('./lib/pull');
const renderMessage = require('./lib/message');

async function run() {
    try {
        console.log(`action: ${github.context.payload.action}`);
        console.log(`[data] payload: ${JSON.stringify(github.context.payload)}`);

        const config = new Config(core);
        console.log(`[data] config: ${JSON.stringify(config)}`);

        const token = core.getInput('GITHUB_TOKEN');
        const octokit = new github.getOctokit(token);

        const {data: prList} = await octokit.pulls.list({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
        })

        const { labels, authors } = config
        if (!labels.length && !authors.length) {
            throw new Error('No labels or authors defined');
        }

        let prListFiltered = prList;
        
        if (labels.length > 0) {
            prListFiltered = prListFiltered.filter(pr => {
                const prLabels = pr.labels.map(label => label.name);
                
                return labels.some(label => prLabels.includes(label));
            });
        }

        if (authors.length > 0) {
            prListFiltered = prListFiltered.filter(pr => authors.includes(pr.user.login))
        }

        if (!prListFiltered.length) {
            throw new Error(`No PRs found for the given labels and authors.\n Authors: ${authors.join(', ')}\n Labels: ${labels.join(', ')}`);
        }

        for (const pr of prListFiltered) {
            console.log(`[info] processing PR #${pr.number} - ${pr.title}`);
            
            const pull = new Pull(pr);
            console.log(`[data] pull (payload): ${JSON.stringify(pull)}`);

            console.log(`[info] get reviews`);
            const reviews = await octokit.pulls.listReviews({
                owner: pull.owner,
                repo: pull.repo,
                pull_number: pull.pull_number
            });

            console.log(`[info] get checks`);
            const checks = await octokit.checks.listForRef({
                owner: pull.owner,
                repo: pull.repo,
                ref: pull.branch_name
            });

            pull.compileReviews(reviews);
            pull.compileChecks(checks);
            console.log(`[data] pull (checks + reviews): ${JSON.stringify(pull)}`);

            console.log(`merge: ${pull.canMerge(config)}`);

            if (config.test_mode) {

                // comment in test mode
                await octokit.issues.createComment({
                    owner: pull.owner,
                    repo: pull.repo,
                    issue_number: pull.pull_number,
                    body: renderMessage(github.context.payload.action, config, pull)
                });

            } else {
                if (pull.canMerge(config)) {

                    console.log(`[info] merge start`);
                    const prData = {
                        owner: pull.owner,
                        repo: pull.repo,
                        pull_number: pull.pull_number,
                        merge_method: config.merge_method,
                    }
                    
                    await octokit.pulls.merge(prData);
                    console.log(`[info] merge complete`);

                    if (config.delete_source_branch) {
                        if (pull.headRepoId !== pull.baseRepoId) {
                            console.log(`[warning] unable to delete branch from fork, branch retained`);
                        } else {
                            console.log(`[info] delete start`);
                            await octokit.git.deleteRef({
                                owner: pull.owner,
                                repo: pull.repo,
                                ref: pull.ref
                            });
                            console.log(`[info] delete complete`);
                        }
                    }
                }
            }
        }
    } catch (error) {
        core.setFailed(error.message);
    }
    
}

run();
