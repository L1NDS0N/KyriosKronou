<#
    Kyrios Chronos - Teste 07: servico do Windows.

    O servico e o processo que roda o agendador quando ninguem esta com o app
    aberto. Ele tem que ser o dono da execucao: o app reconhece e cede a porta.

    Como usar: Kyrios > Servicos. Este script e um resumo do que verificar;
    voce pode instalar o servico pelo proprio Kyrios.
#>
param()

Write-Host ""
Write-Host "Servico do Windows - roteiro de verificacao" -ForegroundColor Cyan
Write-Host ""

Write-Host "1. Instalar" -ForegroundColor White
Write-Host "   - Kyrios > Servicos > instalar: baixa o NSSM se faltar" -ForegroundColor DarkGray
Write-Host "   - o NSSM e dependencia externa; se nao houver, ele e instalado" -ForegroundColor DarkGray
Write-Host "   - o servico fica como 'automatico' e sobe junto com o Windows" -ForegroundColor DarkGray

Write-Host ""
Write-Host "2. Dono da execucao (o ponto que mais causa duvida)" -ForegroundColor White
Write-Host "   - com o servico parado, quem executa e o app" -ForegroundColor DarkGray
Write-Host "   - com o servico ligado e o app aberto, quem executa e o servico" -ForegroundColor DarkGray
Write-Host "   - o app nao briga pela execucao: ele cede" -ForegroundColor DarkGray
Write-Host "   - a bandeja mostra quem esta no comando (rotulo do agendador)" -ForegroundColor DarkGray
Write-Host "   - aba agora duas vezes: nao pode haver tarefa rodando duas" -ForegroundColor DarkGray

Write-Host ""
Write-Host "3. Execucao real" -ForegroundColor White
Write-Host "   - crie uma tarefa 'a cada minuto', so o script de teste 01" -ForegroundColor DarkGray
Write-Host "   - espere dois minutos: deve rodar, e o historico deve mostrar" -ForegroundColor DarkGray
Write-Host "   - a saida vai para a pasta de logs, e nao para a janela do app" -ForegroundColor DarkGray

Write-Host ""
Write-Host "4. Painel web hospedado pelo servico" -ForegroundColor White
Write-Host "   - com o servico dono, quem serve o painel e ele" -ForegroundColor DarkGray
Write-Host "   - o app detecta e nao tenta servir em cima (porta ocupada)" -ForegroundColor DarkGray
Write-Host "   - se voce parar o servico, o app assume o painel de volta" -ForegroundColor DarkGray

Write-Host ""
Write-Host "5. Desinstalar" -ForegroundColor White
Write-Host "   - Kyrios > Servicos > remover: para o servico e apaga os logs" -ForegroundColor DarkGray
Write-Host "   - os dados (tarefas, perfis, historico) NAO sao apagados" -ForegroundColor DarkGray
Write-Host "   - se voce quiser limpar tudo mesmo, apague %ProgramData%\KyriosChronos" -ForegroundColor DarkGray

Write-Host ""
Write-Host "Onde as coisas ficam:" -ForegroundColor Cyan
Write-Host "  dados e configuracao : %ProgramData%\KyriosChronos" -ForegroundColor DarkGray
Write-Host "  logs                 : %ProgramData%\KyriosChronos\logs" -ForegroundColor DarkGray
Write-Host "  scripts gerenciados  : %ProgramData%\KyriosChronos\config\wrappers" -ForegroundColor DarkGray
Write-Host ""
Write-Host "O dado fica fora de %APPDATA% de proposito: o servico roda como" -ForegroundColor DarkGray
Write-Host "LocalSystem e veria outra pasta, gravando a configuracao onde o app" -ForegroundColor DarkGray
Write-Host "nao leria."
