# gh-deploy-bot

This is a GitHub bot that simplifies the process of deployment for organizations from multiple interconnected repositories.


## Diagram flow

<img width="2032" alt="bot-flow" src="./bot-flow.png">


## Setup

1. Create a repo named `.infraway` it should contain a file `config.yaml`. Find example of such configuration in [here](https://github.com/InfraWay/gh-deploy-bot/blob/main/.infraway/config.yaml.example)
2. Install bot into kubernetes cluster using docker image: [infraway/gh-deploy-bot](https://hub.docker.com/r/infraway/gh-deploy-bot)
3. Follow install instructions inside the bot to conect it to GitHub organization.
4. Try to make a PR in a repository, that defined in the `config.yaml` file.

## Docker

```sh
# 1. Build container
docker build -t gh-deploy-bot .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> gh-deploy-bot
```

## Contributing

If you have suggestions for how gh-deploy-bot could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2022 [Andrew Red](https://andrew.red)
