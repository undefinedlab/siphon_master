// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 split zkey sha256=5ed0d2f053c1ffc390dd3140cf23ca863b3183c60f0908c4d6028533ac4f3fb5
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract SpendSplitVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4580662839011174594515474839531762665476444638142026831746976337577717383665;
    uint256 constant deltax2 = 5506049185826224287408407594620187463341814131746179561739573510379785256947;
    uint256 constant deltay1 = 3569818737278656874059033972416244593998827004321679471914943667609724825520;
    uint256 constant deltay2 = 10229270450391977270170638878923533030954287441524780599456916083310877193959;


    uint256 constant IC0x = 17838848845858698392832853771268641479835444562906888559423404940068889556792;
    uint256 constant IC0y = 339486352897853104077078728297763225090025761328393514456694598642885754219;

    uint256 constant IC1x = 7018760025465542539975994619908163688436330081714640715487169935069276634514;
    uint256 constant IC1y = 11466369709303347541327925337976351218164397333712918172765548413689183020703;

    uint256 constant IC2x = 18976561540773165144490396637559433209257604870924904383223644241225176885030;
    uint256 constant IC2y = 7969697768200212864265797815307958354269931214395401819771100408785930965402;

    uint256 constant IC3x = 2212440767279311635206750946085841631817391048295724212028257045992977161837;
    uint256 constant IC3y = 15383214793353452317677409691717930578952450691274659694118061383835804915110;

    uint256 constant IC4x = 13056896176352128405638854901166331989462025859558997736105980423121117405137;
    uint256 constant IC4y = 20711599187113414738202813769451596891122392357748525229851097575552391254613;

    uint256 constant IC5x = 21316748318578070105304475577463316901100597157937570652812926052947648810739;
    uint256 constant IC5y = 21403271006414360529776008812178922783007859656764311619036795077977518472422;

    uint256 constant IC6x = 11660488043811690447835695611295848542577579143730579929015780683605166133054;
    uint256 constant IC6y = 21717678049812017720423075654621860578614388311666012731666584220729442143067;

    uint256 constant IC7x = 5500771884867708641747950593090149003129455981356625938538080022708461036309;
    uint256 constant IC7y = 19401572608670868891458131371863029174338554014027986089092665472884645961304;

    uint256 constant IC8x = 4184325596680703027842025812792274973314000574855467414403703216623991790164;
    uint256 constant IC8y = 14562200588400973185083407387553405064228663332221847743001274864691910995008;

    uint256 constant IC9x = 1278996910010838328887206485266764837817980089121095998676034054535056133583;
    uint256 constant IC9y = 2618694685534782383464515395187546570894857904800982989301860851059266146307;

    uint256 constant IC10x = 12679012161535955784051582468487234312532668367231754986718428470230764033478;
    uint256 constant IC10y = 6256173497670119244939750461275876265404226804066427964610514472094688761228;

    uint256 constant IC11x = 20017660989446378676125011724258194615751077200712314274465808694996869830271;
    uint256 constant IC11y = 15223536921849940401006442111971886671030188476002172121649249034014052413136;

    uint256 constant IC12x = 20121189248029671060237893378951952290307953904769804590971286452144610044763;
    uint256 constant IC12y = 1847788902158007491884975241225974282751796551512093029254001521573742308297;

    uint256 constant IC13x = 4211491257503520919822012663737493790935997669617366788752778018406097180486;
    uint256 constant IC13y = 14957980988484627809636181902373784250899595539899891732154930501655583079983;

    uint256 constant IC14x = 17383749322333077012865015821982765515086350846102302661718688391741689001940;
    uint256 constant IC14y = 15069430398822016517785296938702141139505181083095798828326129234668671391042;

    uint256 constant IC15x = 1566584310427754905455335475587785194272386687284344903580195862835873566799;
    uint256 constant IC15y = 5085998679562315963579334748153435029813478985230009262443603570334662223785;

    uint256 constant IC16x = 17927131816861229358653299376647515261661022813042771179126973751195626877268;
    uint256 constant IC16y = 1698685751850282929002219714491594007402272181140451563981952505449239261238;

    uint256 constant IC17x = 12529683357478441531976933700274137897856812451112222152898584559892085629213;
    uint256 constant IC17y = 10101581702482548707595411091467416518243301826583986124191932210397456450405;

    uint256 constant IC18x = 17084223943969633024297381656194029535544474424399500825537040248815779956234;
    uint256 constant IC18y = 1001254767980636661321541255863994743864417636418727377196213575736247122035;

    uint256 constant IC19x = 7868304726468101043997730639435745144941930211518097023297701590389248866260;
    uint256 constant IC19y = 4451788732796297973708143336787660435147532421469822338613485452622926649511;

    uint256 constant IC20x = 21826355643460683479910577740127484803339489935727932972812550362292066761219;
    uint256 constant IC20y = 1409168825151504446321172911478095446459169924804941817515052040898311480761;

    uint256 constant IC21x = 18170423378889484087631113273560143363490363725964834563506075516765120893659;
    uint256 constant IC21y = 18574417633682515465590606879109819907249616908196484329523266885256154537709;

    uint256 constant IC22x = 4328277117185413207975618539940120128631591618706720238836765969983952797913;
    uint256 constant IC22y = 9961556618181701616944452582981246214861724535507710438393619547635210738993;

    uint256 constant IC23x = 7579767699455198996090660634489867654782308362659109854601331214619812290023;
    uint256 constant IC23y = 795730079244264457754062520230334354653900726607721788687206736409015695691;

    uint256 constant IC24x = 11630682287210243678703345829528021758285709927456365075492907469674814782683;
    uint256 constant IC24y = 21659042794096116602878434045481372785623630243106460617611908393372641050307;

    uint256 constant IC25x = 15700243872274225024976276394570024154617623175828590835591804303364919536198;
    uint256 constant IC25y = 2338814910789108282877445196213307409127866672571960482748945598708688725491;


    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[25] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))

                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))

                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))

                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))

                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))

                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))

                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))

                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))

                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))

                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))

                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))

                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))

                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))

                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))

                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))


                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            checkField(calldataload(add(_pubSignals, 320)))

            checkField(calldataload(add(_pubSignals, 352)))

            checkField(calldataload(add(_pubSignals, 384)))

            checkField(calldataload(add(_pubSignals, 416)))

            checkField(calldataload(add(_pubSignals, 448)))

            checkField(calldataload(add(_pubSignals, 480)))

            checkField(calldataload(add(_pubSignals, 512)))

            checkField(calldataload(add(_pubSignals, 544)))

            checkField(calldataload(add(_pubSignals, 576)))

            checkField(calldataload(add(_pubSignals, 608)))

            checkField(calldataload(add(_pubSignals, 640)))

            checkField(calldataload(add(_pubSignals, 672)))

            checkField(calldataload(add(_pubSignals, 704)))

            checkField(calldataload(add(_pubSignals, 736)))

            checkField(calldataload(add(_pubSignals, 768)))


            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
