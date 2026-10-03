<#
    Kyrios Chronos - Teste 06: painel web e permissoes.

    Voce nao precisa deste script para o painel funcionar - ele serve para
    lembrar o que testar e em que ordem. Cada item tem o que fazer e o que
    voce tem que ver.

    Para rodar: Kyrios > Servicos > painel web (ou o servico, se for ele a
    hospedar). A URL aparece no rodape do app.
#>
param()

Write-Host ""
Write-Host "Painel web - roteiro de verificacao" -ForegroundColor Cyan
Write-Host ""

Write-Host "1. Acesso e sessao" -ForegroundColor White
Write-Host "   - entre sem estar na lista: a pagina de login explica o motivo" -ForegroundColor DarkGray
Write-Host "   - o login usa device flow do GitHub, sem senha de aplicativo" -ForegroundColor DarkGray
Write-Host "   - entre duas vezes: o cookie continua valendo, sem pedir de novo" -ForegroundColor DarkGray
Write-Host "   - cair do allowlist derruba a sessao imediatamente" -ForegroundColor DarkGray
Write-Host "   - /api/health responde sem sessao (e e para isso que serve)" -ForegroundColor DarkGray
Write-Host "   - qualquer /api/* sem sessao responde 401, nao redireciona" -ForegroundColor DarkGray

Write-Host ""
Write-Host "2. Permissoes por tela" -ForegroundColor White
Write-Host "   - Kyrios > Configuracoes > permissoes web: defina uma tela so como leitura" -ForegroundColor DarkGray
Write-Host "   - entre com esse login: a tela some do menu" -ForegroundColor DarkGray
Write-Host "   - chamar a rota direto responde 403 dizendo o escopo que faltou" -ForegroundColor DarkGray
Write-Host "   - escopo de escrita e separado de leitura: da para ler sem poder mudar" -ForegroundColor DarkGray
Write-Host "   - a tela de rede tem escopo proprio: liberar sync na libera a rede" -ForegroundColor DarkGray
Write-Host "   - a chave de API ignora escopo (por desenho), a sessao nao" -ForegroundColor DarkGray

Write-Host ""
Write-Host "3. Seguranca que voce pode verificar" -ForegroundColor White
Write-Host "   - escrever sem o token de CSRF: recusado" -ForegroundColor DarkGray
Write-Host "   - escrever vindo de outra origem: recusado" -ForegroundColor DarkGray
Write-Host "   - abrir o painel pelo F12: nenhum script inline (a CSP barra)" -ForegroundColor DarkGray
Write-Host "   - embutir o painel em outro site: recusado pelo cabecalho" -ForegroundColor DarkGray
Write-Host "   - resposta de API no cache: desabilitado" -ForegroundColor DarkGray
Write-Host "   - senha de backup: nunca aparece em nenhuma resposta" -ForegroundColor DarkGray
Write-Host "   - ManyPasswordsField em branco no editor: significa 'nao mexer'" -ForegroundColor DarkGray

Write-Host ""
Write-Host "4. O que o painel faz" -ForegroundColor White
Write-Host "   - cada tela do menu tem carga propria e botao de recarregar" -ForegroundColor DarkGray
Write-Host "   - executar devolve 200 mesmo quando o motor falha, com o motivo no campo data" -ForegroundColor DarkGray
Write-Host "   - historico abre o mesmo detalhe que o desktop, em modal largo" -ForegroundColor DarkGray
Write-Host "   - calendario: dia, semana e mes, com o resumo do servidor" -ForegroundColor DarkGray
Write-Host "   - envio de scripts: aceita, recusa extensao errada e nome com caminho" -ForegroundColor DarkGray
Write-Host "   - rodape fixo, com metricas e execucoes ao vivo" -ForegroundColor DarkGray

Write-Host ""
Write-Host "5. Rede de sincronismo pelo painel" -ForegroundColor Cyan
Write-Host "   - tela de rede mostra o dashboard de metricas igual ao desktop" -ForegroundColor DarkGray
Write-Host "   - liberar dispositivo exige login do GitHub na sessao" -ForegroundColor DarkGray
Write-Host "   - salvar pasta com dispositivo nao liberado: recusado, dizendo qual" -ForegroundColor DarkGray
Write-Host "   - portao de instalar o daemon: exige escopo de executar, nao so de escrever" -ForegroundColor DarkGray

Write-Host ""
Write-Host "Dica: o painel serve em 127.0.0.1 por padrao. Se voce abriu em outra" -ForegroundColor DarkGray
Write-Host "maquina, o caminho e ApiBindAll, e ai vale conferir a Origin." -ForegroundColor DarkGray
