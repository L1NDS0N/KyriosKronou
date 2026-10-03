<#
    Kyrios Chronos - Teste 09: rede de sincronismo entre maquinas.

    Este aqui precisa de DUAS maquinas (ou uma maquina e uma VM) com o
    Syncthing instalado. O Kyrios dirige o daemon; ele nao e o daemon.

    O ponto critico e a autorizacao: um dispositivo so sincroniza depois de
    ser liberado pelo dono, e a liberacao e pelo id numerico do GitHub
    conferido por OAuth - nunca pelo @login, que qualquer um pode registrar.

    Como usar: Kyrios > Rede > Dispositivos > Entrar com o GitHub.
#>
param()

$feed = 'https://github.com/L1NDS0N/KyriosKronou/releases/latest/download'

Write-Host ""
Write-Host "Rede entre maquinas - roteiro de verificacao" -ForegroundColor Cyan
Write-Host ""

Write-Host "0. Pre-requisito" -ForegroundColor White
Write-Host "   O daemon e o Syncthing, que e GPL e nao entra no instalador." -ForegroundColor DarkGray
Write-Host "   Kyrios > Rede > instalar, se ainda nao estiver. O binario fica" -ForegroundColor DarkGray
Write-Host "   em %ProgramData%\KyriosChronos\syncthing." -ForegroundColor DarkGray

Write-Host ""
Write-Host "1. Dashboard" -ForegroundColor White
Write-Host "   - o painel tem as mesmas linhas do Syncthing: velocidade de" -ForegroundColor DarkGray
Write-Host "     recepcao e envio, estado local, escutadores, descoberta," -ForegroundColor DarkGray
Write-Host "     tempo ligado, identificacao e versao" -ForegroundColor DarkGray
Write-Host "   - 'Descoberta 4/5' significa 4 metodos respondendo de 5 (o IPv6" -ForegroundColor DarkGray
Write-Host "     global costuma falhar; e normal)" -ForegroundColor DarkGray

Write-Host ""
Write-Host "2. Autorizacao entre as maquinas" -ForegroundColor White
Write-Host "   Em cada maquina:" -ForegroundColor DarkGray
Write-Host "     a. Entre com o GitHub (mesma conta nas duas)" -ForegroundColor DarkGray
Write-Host "     b. Rede > Dispositivos: aparece o device ID da outra maquina" -ForegroundColor DarkGray
Write-Host "     c. Clique em Liberar, na outra tambem" -ForegroundColor DarkGray
Write-Host "     d. So agora as duas conversam" -ForegroundColor DarkGray
Write-Host "   - sem liberar dos dois lados, a pasta fica marcada como nao autorizada" -ForegroundColor DarkGray
Write-Host "   - a liberacao vale para o id numerico do GitHub, nao para o @login" -ForegroundColor DarkGray

Write-Host ""
Write-Host "3. Criar e compartilhar uma pasta" -ForegroundColor White
Write-Host "   - Rede > Pastas > Nova, tipo 'Receber e Enviar'" -ForegroundColor DarkGray
Write-Host "   - o caminho NAO pode ser o proprio %ProgramData%\KyriosChronos nem o" -ForegroundColor DarkGray
Write-Host "     app instalado: o app recusa, porque enviaria as chaves do daemon" -ForegroundColor DarkGray
Write-Host "   - marque a outra maquina como destino" -ForegroundColor DarkGray
Write-Host "   - 'so observar alteracoes' e a unica opcao ligada por padrao" -ForegroundColor DarkGray
Write-Host ""

Write-Host "4. Compactar" -ForegroundColor White
Write-Host "   - 'Por data': 7z por arquivo, um .7z por dia" -ForegroundColor DarkGray
Write-Host "   - 'Por tamanho': um .7z so quando a pasta passa de X" -ForegroundColor DarkGray
Write-Host "   - a compactacao so roda com a pasta em 100%, nunca em transito" -ForegroundColor DarkGray
Write-Host "   - o caminho do .7z nao pode ser dentro da pasta" -ForegroundColor DarkGray

Write-Host ""
Write-Host "5. Para desfazer" -ForegroundColor White
Write-Host "   - Rede > Pastas > Restaurar arquivos do compactado" -ForegroundColor DarkGray
Write-Host "   - isso extrai o .7z de volta na pasta" -ForegroundColor DarkGray
Write-Host "   - so funciona se o .7z ainda existir" -ForegroundColor DarkGray

Write-Host ""
Write-Host "Atualizacao do proprio app" -ForegroundColor White
Write-Host "   A release publica latest.yml com a versao, a URL relativa e o sha512." -ForegroundColor DarkGray
Write-Host "   O rodape mostra 'Nova versao X' quando ha uma; clicar baixa e instala." -ForegroundColor DarkGray
Write-Host "   Feed: $feed" -ForegroundColor DarkGray
Write-Host "   - o portable NAO se atualiza sozinho (ele e o arquivo que voce carrega)" -ForegroundColor DarkGray
Write-Host "   - links externos abrem no navegador, nunca dentro do app" -ForegroundColor DarkGray
